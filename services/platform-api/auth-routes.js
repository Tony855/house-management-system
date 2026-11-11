'use strict';

const express = require('express');

function createPlatformAuthRouter({ authService, mfaService, auditStore, adminStore }) {
  if (!authService || !['login', 'verifyChallenge', 'authenticate', 'stepUp', 'logout']
    .every(method => typeof authService[method] === 'function')) throw new TypeError('PLATFORM_ADMIN_AUTH_SERVICE_REQUIRED');
  if (!mfaService || !['beginEnrollment', 'confirmEnrollment', 'getStatus', 'rotateRecoveryCodes']
    .every(method => typeof mfaService[method] === 'function')) throw new TypeError('PLATFORM_ADMIN_MFA_SERVICE_REQUIRED');
  if (auditStore && typeof auditStore.append !== 'function') throw new TypeError('PLATFORM_ADMIN_AUDIT_STORE_REQUIRED');
  const router = express.Router();
  async function audit(req, action, outcome, code = null) {
    if (!auditStore) return;
    await auditStore.append({
      adminId: req.platformAuth?.adminId ?? null,
      sessionId: req.platformAuth?.sessionId ?? null,
      action, outcome, code
    });
  }
  const requireRecentMfa = (req, _res, next) => {
    if (req.platformAuth?.mfaVerified !== true) return next(Object.assign(new Error('PLATFORM_MFA_REAUTH_REQUIRED'), {
      code: 'PLATFORM_MFA_REAUTH_REQUIRED', status: 403
    }));
    return next();
  };
  router.post('/login', async (req, res, next) => {
    try {
      const result = await authService.login({ username: req.body?.username, password: req.body?.password });
      await audit(req, 'admin.login', 'success');
      res.status(200).json(result);
    } catch (error) { try { await audit(req, 'admin.login', 'failure', error.code || 'AUTHENTICATION_FAILED'); } catch (_) {} next(error); }
  });
  router.post('/mfa/verify', async (req, res, next) => {
    try {
      const result = await authService.verifyChallenge({ challenge: req.body?.challenge, code: req.body?.code });
      await audit(req, 'admin.mfa.verify', 'success');
      res.status(200).json(result);
    } catch (error) { try { await audit(req, 'admin.mfa.verify', 'failure', error.code || 'MFA_FAILED'); } catch (_) {} next(error); }
  });
  router.get('/mfa/status', authService.authenticate, async (req, res, next) => {
    try {
      const result = await mfaService.getStatus({ adminId: req.platformAuth.adminId });
      res.status(200).json(result);
    } catch (error) { next(error); }
  });
  router.post('/mfa/enrollment', authService.authenticate, requireRecentMfa, async (req, res, next) => {
    try {
      const result = await mfaService.beginEnrollment({ adminId: req.platformAuth.adminId, account: String(req.platformAuth.adminId) });
      await audit(req, 'admin.mfa.enrollment.begin', 'success');
      res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache');
      res.status(200).json(result);
    } catch (error) { try { await audit(req, 'admin.mfa.enrollment.begin', 'failure', error.code || 'MFA_ENROLLMENT_FAILED'); } catch (_) {} next(error); }
  });
  router.post('/mfa/enrollment/confirm', authService.authenticate, requireRecentMfa, async (req, res, next) => {
    try {
      const result = await mfaService.confirmEnrollment({ adminId: req.platformAuth.adminId, code: req.body?.code });
      await audit(req, 'admin.mfa.enrollment.confirm', 'success');
      res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache');
      res.status(200).json(result);
    } catch (error) { try { await audit(req, 'admin.mfa.enrollment.confirm', 'failure', error.code || 'MFA_CONFIRM_FAILED'); } catch (_) {} next(error); }
  });
  router.post('/mfa/recovery-codes/rotate', authService.authenticate, requireRecentMfa, async (req, res, next) => {
    try {
      const result = await mfaService.rotateRecoveryCodes({ adminId: req.platformAuth.adminId, code: req.body?.code });
      await audit(req, 'admin.mfa.recovery.rotate', 'success');
      res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache');
      res.status(200).json(result);
    } catch (error) { try { await audit(req, 'admin.mfa.recovery.rotate', 'failure', error.code || 'MFA_ROTATION_FAILED'); } catch (_) {} next(error); }
  });
  router.post('/step-up', authService.authenticate, async (req, res, next) => {
    try {
      const result = await authService.stepUp({ adminId: req.platformAuth.adminId, sessionId: req.platformAuth.sessionId, code: req.body?.code });
      await audit(req, 'admin.step_up', 'success');
      res.status(200).json(result);
    } catch (error) { try { await audit(req, 'admin.step_up', 'failure', error.code || 'STEP_UP_FAILED'); } catch (_) {} next(error); }
  });
  router.post('/logout', authService.authenticate, async (req, res, next) => {
    try {
      await authService.logout({ adminId: req.platformAuth.adminId, sessionId: req.platformAuth.sessionId });
      await audit(req, 'admin.logout', 'success');
      res.status(204).end();
    } catch (error) { next(error); }
  });
  router.post('/admins/:adminId/disable', authService.authenticate, (req, _res, next) => {
    if (!req.platformAuth?.permissions?.includes('platform:admins:write') ||
        req.platformAuth.stepUpVerified !== true) {
      return next(Object.assign(new Error('PLATFORM_ADMIN_STEP_UP_REQUIRED'), {
        code: 'PLATFORM_ADMIN_STEP_UP_REQUIRED', status: 403
      }));
    }
    return next();
  }, async (req, res, next) => {
    try {
      const targetAdminId = Number(req.params.adminId);
      if (!Number.isSafeInteger(targetAdminId) || targetAdminId < 1) {
        return next(Object.assign(new Error('PLATFORM_ADMIN_ID_INVALID'), { code: 'PLATFORM_ADMIN_ID_INVALID', status: 400 }));
      }
      if (!adminStore || typeof adminStore.disableAdmin !== 'function') {
        return next(Object.assign(new Error('PLATFORM_ADMIN_MANAGEMENT_UNAVAILABLE'), { code: 'PLATFORM_ADMIN_MANAGEMENT_UNAVAILABLE', status: 503 }));
      }
      const disabled = await adminStore.disableAdmin({ actorAdminId: req.platformAuth.adminId, targetAdminId, sessionId: req.platformAuth.sessionId });
      if (disabled !== true) {
        return next(Object.assign(new Error('PLATFORM_ADMIN_DISABLE_REJECTED'), { code: 'PLATFORM_ADMIN_DISABLE_REJECTED', status: 409 }));
      }
      return res.status(204).end();
    } catch (error) { return next(error); }
  });
  return router;
}

module.exports = { createPlatformAuthRouter };
