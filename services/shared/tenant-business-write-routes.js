'use strict';

const express = require('express');

const CONFIG = Object.freeze({
  rental: {
    tenantFields: new Set(['name', 'gender', 'phone', 'id_card', 'remark']),
    tenantDefaults: ['name', 'gender', 'phone', 'id_card', 'remark'],
    tenantRequired: ['name'],
    tenantLimits: { name: 50, phone: 20, id_card: 30, remark: 200 },
    gender: new Set(['男', '女'])
  },
  hotel: {
    tenantFields: new Set(['name', 'gender', 'phone', 'id_card', 'remark']),
    tenantDefaults: ['name', 'gender', 'phone', 'id_card', 'remark'],
    tenantRequired: ['name'],
    tenantLimits: { name: 50, phone: 20, id_card: 30, remark: 200 },
    gender: new Set(['男', '女'])
  },
  property: {
    tenantFields: new Set(['name', 'contact', 'phone', 'license_no', 'remark']),
    tenantDefaults: ['name', 'contact', 'phone', 'license_no', 'remark'],
    tenantRequired: ['name'],
    tenantLimits: { name: 100, contact: 50, phone: 20, license_no: 50, remark: 200 }
  }
});

function fail(code, status) { return Object.assign(new Error(code), { code, status }); }
function validateTenant(appId, input, partial = false) {
  const config = CONFIG[appId];
  if (!config || !input || typeof input !== 'object' || Array.isArray(input)) throw fail('TENANT_INPUT_INVALID', 400);
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => !config.tenantFields.has(key))) throw fail('TENANT_INPUT_INVALID', 400);
  const out = {};
  for (const key of config.tenantDefaults) {
    if (!Object.hasOwn(input, key)) {
      if (!partial && config.tenantRequired.includes(key)) throw fail('TENANT_INPUT_INVALID', 400);
      continue;
    }
    const value = input[key];
    if (typeof value !== 'string' || value.length > config.tenantLimits[key] || (key === 'name' && !value.trim())) {
      throw fail('TENANT_INPUT_INVALID', 400);
    }
    if (key === 'gender' && !config.gender.has(value)) throw fail('TENANT_INPUT_INVALID', 400);
    out[key] = value.trim();
  }
  return Object.freeze(out);
}
function validateRepair(input, partial = false) {
  const allowed = new Set(['room_id', 'title', 'content', 'status', 'handler', 'handle_note']);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('REPAIR_INPUT_INVALID', 400);
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => !allowed.has(key))) throw fail('REPAIR_INPUT_INVALID', 400);
  const out = {};
  if (Object.hasOwn(input, 'room_id')) {
    const id = Number(input.room_id);
    if (!Number.isSafeInteger(id) || id < 1) throw fail('REPAIR_INPUT_INVALID', 400);
    out.room_id = id;
  } else if (!partial) throw fail('REPAIR_INPUT_INVALID', 400);
  for (const [key, max] of [['title', 100], ['content', 500], ['handler', 50], ['handle_note', 500]]) {
    if (Object.hasOwn(input, key)) {
      if (typeof input[key] !== 'string' || input[key].length > max || (key === 'title' && !input[key].trim())) {
        throw fail('REPAIR_INPUT_INVALID', 400);
      }
      out[key] = input[key].trim();
    }
  }
  if (Object.hasOwn(input, 'status')) {
    if (!['pending', 'processing', 'done'].includes(input.status)) throw fail('REPAIR_INPUT_INVALID', 400);
    out.status = input.status;
  }
  if (!partial && !out.title) throw fail('REPAIR_INPUT_INVALID', 400);
  return Object.freeze(out);
}

function createTenantBusinessWriteRouter(appId) {
  if (!CONFIG[appId]) throw new TypeError('TENANT_WRITE_PRODUCT_INVALID');
  const router = express.Router();
  router.post('/tenants', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const tenant = validateTenant(appId, req.body);
      const result = await req.tenantWrite({
        operation: 'create', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { ...tenant, __resource: 'tenants' },
        mutate: async tx => {
          const inserted = await tx.insert('tenants', tenant);
          return { id: Number(inserted.insertId), ...tenant };
        }
      });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  const updateTenant = async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw fail('TENANT_ID_INVALID', 400);
      const patch = validateTenant(appId, req.body, true);
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { id, patch, __resource: 'tenants' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT id FROM tenants WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw fail('TENANT_NOT_FOUND', 404);
          await tx.updateById('tenants', id, patch);
          return { id, ...patch };
        }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  };
  router.put('/tenants/:id', updateTenant);
  router.patch('/tenants/:id', updateTenant);

  router.post('/repairs', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const repair = validateRepair(req.body);
      const result = await req.tenantWrite({
        operation: 'create', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { ...repair, __resource: 'repairs' },
        mutate: async tx => {
          const [rooms] = await tx.execute('SELECT id FROM rooms WHERE id = ? LIMIT 1 FOR UPDATE', [repair.room_id]);
          if (!rooms.length) throw fail('ROOM_NOT_FOUND', 404);
          const inserted = await tx.insert('repairs', repair);
          return { id: Number(inserted.insertId), ...repair, status: repair.status || 'pending' };
        }
      });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  const updateRepair = async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw fail('REPAIR_ID_INVALID', 400);
      const patch = validateRepair(req.body, true);
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { id, patch, __resource: 'repairs' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT id, status FROM repairs WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw fail('REPAIR_NOT_FOUND', 404);
          const current = rows[0].status;
          if (patch.status && !(
            patch.status === current ||
            (current === 'pending' && patch.status === 'processing') ||
            (current === 'processing' && patch.status === 'done')
          )) throw fail('REPAIR_STATUS_TRANSITION_INVALID', 409);
          if (patch.room_id) {
            const [rooms] = await tx.execute('SELECT id FROM rooms WHERE id = ? LIMIT 1 FOR UPDATE', [patch.room_id]);
            if (!rooms.length) throw fail('ROOM_NOT_FOUND', 404);
          }
          await tx.updateById('repairs', id, patch);
          return { id, ...patch };
        }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  };
  router.put('/repairs/:id', updateRepair);
  router.patch('/repairs/:id', updateRepair);
  return router;
}

module.exports = { createTenantBusinessWriteRouter, validateTenant, validateRepair };
