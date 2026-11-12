'use strict';
const express = require('express');
const { createProductApi } = require('../../server/product-api');
const { createTenantReadRouter } = require('../shared/tenant-read-routes');
const { createRoomUpdateRouter } = require('../shared/room-update-routes');
const { createRentalWriteRouter } = require('./write-routes');

function createRentalApi(dependencies) {
  return createProductApi({
    ...dependencies,
    appId: 'rental',
    routes: dependencies.routes || (() => {
      const router = express.Router();
      router.use(createTenantReadRouter({ appId: 'rental' }));
      router.use(createRoomUpdateRouter('rental'));
      router.use(createRentalWriteRouter());
      return router;
    })
  });
}
module.exports = { createRentalApi };
