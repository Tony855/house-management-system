'use strict';

const express = require('express');
const { assertPlatformAdmin } = require('./platform-authz');

function createPlatformBillingRouter({ repository, authenticate }) {
  if (!repository) throw new TypeError('PLATFORM_REPOSITORY_REQUIRED');
  if (typeof authenticate !== 'function') throw new TypeError('PLATFORM_AUTHENTICATOR_REQUIRED');
  const router = express.Router();
  router.use((req, res, next) => Promise.resolve(authenticate(req, res, next)).catch(next));

  const authorize = permission => (req, res, next) => {
    try {
      assertPlatformAdmin(req.platformAuth, permission, { reason: req.get('x-action-reason') });
      next();
    } catch (error) { res.status(error.status || 403).json({ error: error.code || 'PLATFORM_ACCESS_DENIED' }); }
  };
  const bounded = value => Math.min(500, Math.max(1, Number.isInteger(Number(value)) ? Number(value) : 100));
  // Bound offset scans; huge integer query values can otherwise force costly
  // deep scans or exceed driver integer ranges.
  const offset = value => Math.min(1000000, Math.max(0, Number.isSafeInteger(Number(value)) ? Number(value) : 0));

  router.get('/overview', authorize('platform:read'), async (req, res, next) => {
    try { res.json(await repository.overview()); } catch (e) { next(e); }
  });
  router.get('/products', authorize('products:read'), async (req, res, next) => {
    try { res.json(await repository.listProducts()); } catch (e) { next(e); }
  });
  router.get('/plans', authorize('plans:read'), async (req, res, next) => {
    try {
      res.json(await repository.listPlans({
        productCode: req.query.product || undefined,
        status: req.query.status || undefined,
        limit: bounded(req.query.limit), offset: offset(req.query.offset)
      }));
    } catch (e) { next(e); }
  });
  router.post('/plans', authorize('plans:write'), async (req, res, next) => {
    try {
      const body = req.body || {};
      const productCode = typeof body.productCode === 'string' ? body.productCode.trim() : '';
      const planCode = typeof body.planCode === 'string' ? body.planCode.trim() : '';
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      const interval = body.interval;
      const currency = typeof body.currency === 'string' ? body.currency.toUpperCase() : '';
      if (!/^[a-z][a-z0-9_-]{1,39}$/.test(productCode) ||
          !/^[a-zA-Z0-9_-]{2,60}$/.test(planCode) || !displayName || displayName.length > 120 ||
          !['month', 'year', 'once'].includes(interval) ||
          !/^[A-Z]{3}$/.test(currency) || !Number.isSafeInteger(body.amountMinor) || body.amountMinor < 0 ||
          !Number.isInteger(body.trialDays || 0) || (body.trialDays || 0) < 0 || (body.trialDays || 0) > 365) {
        return res.status(400).json({ error: 'PLAN_INPUT_INVALID' });
      }
      const result = await repository.createPlan({
        productCode, planCode, displayName, interval, currency,
        amountMinor: body.amountMinor, trialDays: body.trialDays || 0,
        limits: body.limits && typeof body.limits === 'object' && !Array.isArray(body.limits) ? body.limits : {},
        features: body.features && typeof body.features === 'object' && !Array.isArray(body.features) ? body.features : {}
      }, {
        adminId: req.platformAuth.adminId,
        reason: req.get('x-action-reason').trim(),
        requestId: req.id || null
      });
      res.status(201).json(result);
    } catch (e) { next(e); }
  });
  router.get('/tenants', authorize('tenants:read'), async (req, res, next) => {
    try {
      const rows = await repository.listTenants({
        appId: ['rental', 'hotel', 'property'].includes(req.query.app) ? req.query.app : undefined,
        state: ['provisioning', 'provisioning_failed', 'active', 'suspended', 'deleting', 'deleted'].includes(req.query.state) ? req.query.state : undefined,
        limit: bounded(req.query.limit), offset: offset(req.query.offset)
      });
      // Defense in depth: never serialize database routing or secret metadata,
      // even if a repository implementation accidentally returns extra columns.
      res.json(rows.map(row => ({
        tenant_uuid: row.tenant_uuid,
        app_id: row.app_id,
        display_label: row.display_label,
        lifecycle_state: row.lifecycle_state,
        schema_version: row.schema_version,
        created_at: row.created_at,
        updated_at: row.updated_at
      })));
    } catch (e) { next(e); }
  });
  router.get('/invoices', authorize('billing:read'), async (req, res, next) => {
    try {
      res.json(await repository.listInvoices({
        tenantId: req.query.tenant || undefined, status: req.query.status || undefined,
        limit: bounded(req.query.limit), offset: offset(req.query.offset)
      }));
    } catch (e) { next(e); }
  });
  router.get('/ledger', authorize('billing:read'), async (req, res, next) => {
    try {
      res.json(await repository.listLedger({
        tenantId: req.query.tenant || undefined,
        currency: /^[A-Z]{3}$/.test(String(req.query.currency || '').toUpperCase()) ? String(req.query.currency).toUpperCase() : undefined,
        limit: bounded(req.query.limit), offset: offset(req.query.offset)
      }));
    } catch (e) { next(e); }
  });
  return router;
}

module.exports = { createPlatformBillingRouter };
