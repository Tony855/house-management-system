'use strict';

const express = require('express');
const { COLUMNS, TABLES } = require('../../server/tenant-repository');

const PATHS = Object.freeze({
  rental: { buildings: 'buildings', rooms: 'rooms', tenants: 'tenants', contracts: 'contracts', meters: 'meters', room_net_lines: 'network-lines', net_changes: 'network-changes', net_requests: 'network-requests', bills: 'bills', bill_transactions: 'bill-transactions', repairs: 'repairs' },
  hotel: { buildings: 'buildings', rooms: 'rooms', tenants: 'tenants', orders: 'orders', bills: 'bills', repairs: 'repairs' },
  property: { buildings: 'buildings', rooms: 'rooms', tenants: 'tenants', org_employees: 'employees', meters: 'meters', room_net_lines: 'network-lines', net_changes: 'network-changes', net_requests: 'network-requests', bills: 'bills', bill_transactions: 'bill-transactions', repairs: 'repairs', complaints: 'complaints' }
});

function createTenantReadRouter({ appId }) {
  if (!PATHS[appId]) throw new TypeError('PRODUCT_READ_ROUTES_APP_INVALID');
  const router = express.Router();
  for (const [table, path] of Object.entries(PATHS[appId])) {
    router.get('/' + path, async (req, res, next) => {
      try {
        const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
        const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
        const direction = req.query.direction === undefined ? 'ASC' : String(req.query.direction).toUpperCase();
        const orderBy = req.query.sort === undefined ? 'id' : String(req.query.sort);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
            !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 ||
            !['ASC', 'DESC'].includes(direction) || !COLUMNS[appId][table].includes(orderBy)) {
          return res.status(400).json({ error: 'QUERY_INVALID' });
        }
        const [items, total] = await Promise.all([
          req.tenantRepository.list(table, { limit, offset, orderBy, direction }),
          req.tenantRepository.count(table)
        ]);
        return res.json({ items, total, limit, offset });
      } catch (error) {
        return next(error);
      }
    });
  }
  return router;
}

module.exports = { PATHS, createTenantReadRouter };
