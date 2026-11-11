'use strict';

const express = require('express');

function createPlatformAuthRouter({ authService, mfaService }) {
  if (!authService || !['login', 'verifyChallenge', 'authenticate', 'stepUp', 'logout']
    .every(method => typeof authService[method] === 'function')) {
    throw new TypeError('PLATFORM_ADMIN_AUTH_SERVICE_REQUIRED');
  }
  if (!mfaService || !['beginEnrollment', 'confirmEnrollment', 'getStatus', 'rotateRecoveryCodes']
    .every(method => typeof mfaService[method] === 'function')) {
    throw new TypeError('PLATFORM_ADMIN_MFA_SERVICE_REQUIRED');
  }
  const router = express.Router();
  const requireRecentMfa = (req, _res, next) => {
    if (req.platformAuth?.mfaVerified !== true) {
      return next(Object.assign(new Error('PLATFORM_MFA_REAUTH_REQUIRED'), {
        code: 'PLATFORM_MFA_REAUTH_REQUIRED', status: 403
      }));
    }
    return next();
  };
  router.post('/login', async (req, res, next) => {
    try {
      const result = await authService.login({
        username: req.body?.username,
        password: req.body?.password
      });
      res.status(200).json(result);
    } catch (error) { next(error); }
  });
  router.post('/mfa/verify', async (req, res, next) => {
    try {
      const result = await authService.verifyChallenge({
        challenge: req.body?.challenge,
        code: req.body?.code
      });
      res.status(200).json(result);
    } catch (error) { next(error); }
  });
  router.get('/mfa/status', authService.authenticate, async (req, res, next) => {
    try {
      const result = await mfaService.getStatus({ adminId: req.platformAuth.adminId });
      res.status(200).json(result);
    } catch (error) { next(error); }
  });
  router.post('/mfa/enrollment', authService.authenticate, requireRecentMfa, async (req, res, next) => {
    try {
      const result = await mfaService.beginEnrollment({
        adminId: req.platformAuth.adminId,
        account: req.platformAuth.username || String(req.platformAuth.adminId)
      });
      res.status(200).json(result);
    } catch (error) { next(error); }
  });
  router.post('/mfa/enrollment/confirm', authService.authenticate, requireRecentMfa, async (req, res, next) => {
    try {
      const result = await mfaService.confirmEnrollment({
        adminId: req.platformAuth.adminId,
        code: req.body?.code
      });
      res.status(200).json(result);
    } catch (error) { next(error); }
  });
  router.post('/mfa/recovery-codes/rotate', authService.authenticate, requireRecentMfa, async (req, res, next) => {
    try {
      const result = await mfaService.rotateRecoveryCodes({
        adminId: req.platformAuth.adminId,
        code: req.body?.code
      });
      res.status(200).json(result);
    } catch (error) { next(error); }
  });
  router.post('/step-up', authService.authenticate, async (req, res, next) => {
    try {
      const result = await authService.stepUp({
        adminId: req.platformAuth.adminId,
        sessionId: req.platformAuth.sessionId,
        code: req.body?.code
      });
      res.status(200).json(result);
    } catch (error) { next(error); }
  });
  router.post('/logout', authService.authenticate, async (req, res, next) => {
    try {
      await authService.logout({
        adminId: req.platformAuth.adminId,
        sessionId: req.platformAuth.sessionId
      });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}

module.exports = { createPlatformAuthRouter };
