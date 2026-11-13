'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlatformApi } = require('../services/platform-api/app');

test('platform API starts and exposes shutdown for migration runner only when executor is injected', async () => {
  const pool = {
    query: async () => [[], []],
    getConnection: async () => ({
      beginTransaction: async () => {}, query: async () => [[], []],
      commit: async () => {}, rollback: async () => {}, release: () => {}
    })
  };
  const authenticate = (_req, _res, next) => next();
  const dormant = createPlatformApi({ pool, authenticate });
  assert.equal(typeof dormant.locals.stopTenantMigrationRunner, 'function');
  assert.equal(dormant.locals.tenantMigrationRunner, undefined);
  await dormant.locals.stopTenantMigrationRunner();

  const active = createPlatformApi({
    pool, authenticate, migrationWorkerId: 'test-worker',
    migrationExecutor: async () => ({ cutover: false })
  });
  assert.equal(active.locals.tenantMigrationRunner.isRunning(), true);
  await active.locals.stopTenantMigrationRunner();
  assert.equal(active.locals.tenantMigrationRunner.isRunning(), false);
});
