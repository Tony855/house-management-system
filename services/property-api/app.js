'use strict';
const express = require('express');
const { createProductApi } = require('../../server/product-api');
const { createTenantReadRouter } = require('../shared/tenant-read-routes');
const { createProductRoomWriteRouter } = require('../shared/product-room-write-routes');
function createPropertyApi(dependencies) {
  return createProductApi({ ...dependencies, appId: 'property', routes: dependencies.routes || (() => {
    const router = express.Router();
    router.use(createTenantReadRouter({ appId: 'property' }));
    router.use(createProductRoomWriteRouter('property'));
    return router;
  }) });
}
module.exports = { createPropertyApi };
