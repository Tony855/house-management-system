'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { createFinanceReconciliationRouter } = require('../services/shared/finance-reconciliation-routes');

test('finance reconciliation includes every timestamp on the inclusive end date', async () => {
  const calls = [];
  const app = express();
  app.use((req, _res, next) => {
    req.tenantDb = {
      execute: async (sql, params) => {
        calls.push({ sql, params });
        return [[{ source: 'rental', bills_count: 1, receipts: '25.00', refunds: '0.00', net_transactions: '25.00', mismatch_count: 0 }]];
      }
    };
    next();
  });
  app.use('/api', createFinanceReconciliationRouter('rental'));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || 'ERROR' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port +
      '/api/finance/reconciliation?from_date=2026-11-01&to_date=2026-11-30');
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /transaction_date >= \? AND transaction_date < DATE_ADD\(\?, INTERVAL 1 DAY\)/);
    assert.deepEqual(calls[0].params, ['2026-11-01', '2026-11-30', '2026-11-01', '2026-11-30']);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
