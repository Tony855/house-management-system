'use strict';
const express = require('express');
function reconciliationError(code) { return Object.assign(new Error(code), { code, status: 400 }); }
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function validateReconciliationRange(query) {
  const fromDate = query?.from_date, toDate = query?.to_date;
  if (!validDate(fromDate) || !validDate(toDate) || fromDate > toDate) throw reconciliationError('FINANCE_RECONCILIATION_RANGE_INVALID');
  const days = (Date.parse(toDate + 'T00:00:00Z') - Date.parse(fromDate + 'T00:00:00Z')) / 86400000;
  if (days > 366) throw reconciliationError('FINANCE_RECONCILIATION_RANGE_TOO_LARGE');
  return Object.freeze({ from_date: fromDate, to_date: toDate });
}
function createFinanceReconciliationRouter(appId) {
  if (!['rental','hotel','property'].includes(appId)) throw new TypeError('FINANCE_RECONCILIATION_APP_INVALID');
  const router = express.Router();
  router.get('/finance/reconciliation', async (req, res, next) => {
    try {
      if (!req.tenantDb || typeof req.tenantDb.execute !== 'function') return res.status(503).json({ error: 'TENANT_DATABASE_UNAVAILABLE' });
      const range = validateReconciliationRange(req.query);
      const [rows] = await req.tenantDb.execute(
        `SELECT b.source, COUNT(*) AS bills_count,
          COALESCE(SUM(t.receipts), 0) AS receipts,
          COALESCE(SUM(t.refunds), 0) AS refunds,
          COALESCE(SUM(t.receipts - t.refunds), 0) AS net_transactions,
          SUM(CASE WHEN ABS(COALESCE(t.net_lifetime, 0) - b.paid_amount) > 0.009 THEN 1 ELSE 0 END) AS mismatch_count
        FROM bills b
        LEFT JOIN (
          SELECT bill_id,
            SUM(CASE WHEN transaction_type = 'receipt' AND transaction_date >= ? AND transaction_date < DATE_ADD(?, INTERVAL 1 DAY) THEN amount ELSE 0 END) AS receipts,
            SUM(CASE WHEN transaction_type = 'refund' AND transaction_date >= ? AND transaction_date < DATE_ADD(?, INTERVAL 1 DAY) THEN amount ELSE 0 END) AS refunds,
            SUM(CASE WHEN transaction_type = 'receipt' THEN amount ELSE -amount END) AS net_lifetime
          FROM bill_transactions GROUP BY bill_id
        ) t ON t.bill_id = b.id
        GROUP BY b.source ORDER BY b.source`,
        [range.from_date, range.to_date, range.from_date, range.to_date]
      );
      const items = rows.map(row => ({
        source: row.source, bills_count: Number(row.bills_count),
        receipts: Number(row.receipts), refunds: Number(row.refunds),
        net_transactions: Number(row.net_transactions), mismatch_count: Number(row.mismatch_count)
      }));
      return res.json({
        ...range, items,
        totals: items.reduce((total, item) => ({
          bills_count: total.bills_count + item.bills_count,
          receipts: Math.round((total.receipts + item.receipts) * 100) / 100,
          refunds: Math.round((total.refunds + item.refunds) * 100) / 100,
          net_transactions: Math.round((total.net_transactions + item.net_transactions) * 100) / 100,
          mismatch_count: total.mismatch_count + item.mismatch_count
        }), { bills_count: 0, receipts: 0, refunds: 0, net_transactions: 0, mismatch_count: 0 })
      });
    } catch (error) { return next(error); }
  });
  return router;
}
module.exports = { validateReconciliationRange, createFinanceReconciliationRouter };
