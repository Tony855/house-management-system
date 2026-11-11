'use strict';

const express = require('express');

function createPlatformAuthRouter({ authService }) {
  if (!authService || !['login', 'verifyChallenge', 'authenticate', 'stepUp', 'logout']
    .every(method => typeof authService[method] === 'function')) {
    throw new TypeError('PLATFORM_ADMIN_AUTH_SERVICE_REQUIRED');
  }
  const router = express.Router();
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
