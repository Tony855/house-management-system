'use strict';

const express = require('express');
function fail(code, status) { return Object.assign(new Error(code), { code, status }); }
function validate(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('BUILDING_INPUT_INVALID', 400);
  const allowed = new Set(['name', 'address', 'remark']);
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => !allowed.has(key))) throw fail('BUILDING_INPUT_INVALID', 400);
  const out = {};
  if (Object.hasOwn(input, 'name')) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120) throw fail('BUILDING_INPUT_INVALID', 400);
    out.name = input.name.trim();
  } else if (!partial) throw fail('BUILDING_INPUT_INVALID', 400);
  for (const key of ['address', 'remark']) {
    if (Object.hasOwn(input, key)) {
      const max = key === 'address' ? 255 : 500;
      if (typeof input[key] !== 'string' || input[key].length > max) throw fail('BUILDING_INPUT_INVALID', 400);
      out[key] = input[key].trim();
    }
  }
  return Object.freeze(out);
}
function createBuildingWriteRouter() {
  const router = express.Router();
  router.post('/buildings', async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const building = validate(req.body);
      const result = await req.tenantWrite({
        operation: 'create', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { ...building, __resource: 'buildings' },
        mutate: async tx => {
          const [existing] = await tx.execute('SELECT id FROM buildings WHERE name = ? LIMIT 1 FOR UPDATE', [building.name]);
          if (existing.length) throw fail('BUILDING_ALREADY_EXISTS', 409);
          const inserted = await tx.insert('buildings', building);
          return { id: Number(inserted.insertId), ...building };
        }
      });
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  });
  const update = async (req, res, next) => {
    try {
      if (typeof req.tenantWrite !== 'function') return res.status(503).json({ error: 'TENANT_WRITE_UNAVAILABLE' });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw fail('BUILDING_ID_INVALID', 400);
      const patch = validate(req.body, true);
      const result = await req.tenantWrite({
        operation: 'update', reason: req.get('x-operation-reason'),
        stepUpToken: req.get('x-step-up-token'), requestId: req.get('idempotency-key'),
        payload: { id, patch, __resource: 'buildings' },
        mutate: async tx => {
          const [rows] = await tx.execute('SELECT id, name, address, remark FROM buildings WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
          if (!rows.length) throw fail('BUILDING_NOT_FOUND', 404);
          const merged = validate({ name: rows[0].name, address: rows[0].address || '', remark: rows[0].remark || '', ...patch });
          if (merged.name !== rows[0].name) {
            const [duplicates] = await tx.execute('SELECT id FROM buildings WHERE name = ? AND id <> ? LIMIT 1 FOR UPDATE', [merged.name, id]);
            if (duplicates.length) throw fail('BUILDING_ALREADY_EXISTS', 409);
          }
          await tx.updateById('buildings', id, merged);
          return { id, ...merged };
        }
      });
      return res.json(result);
    } catch (error) { return next(error); }
  };
  router.put('/buildings/:id', update);
  router.patch('/buildings/:id', update);
  return router;
}
module.exports = { createBuildingWriteRouter, validateBuilding: validate };
