'use strict';
const express = require('express');
const { createProductApi } = require('../../server/product-api');
const { createTenantReadRouter } = require('../shared/tenant-read-routes');
const { createTenantBusinessWriteRouter } = require('../shared/tenant-business-write-routes');
const { createBuildingWriteRouter } = require('../shared/building-write-routes');
const { createRoomUpdateRouter } = require('../shared/room-update-routes');
const { createProductRoomWriteRouter } = require('../shared/product-room-write-routes');
const { createMeterWriteRouter } = require('../shared/meter-write-routes');
function createPropertyApi(dependencies) {
  return createProductApi({ ...dependencies, appId: 'property', routes: dependencies.routes || (() => {
    const router = express.Router();
    router.use(createTenantReadRouter({ appId: 'property' }));
      router.use(createTenantBusinessWriteRouter('property'));
    router.use(createBuildingWriteRouter());
    router.use(createRoomUpdateRouter('property'));
    router.use(createProductRoomWriteRouter('property'));
    router.use(createMeterWriteRouter('property'));
    return router;
  }) });
}
module.exports = { createPropertyApi };
