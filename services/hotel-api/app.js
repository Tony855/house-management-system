'use strict';
const express = require('express');
const { createProductApi } = require('../../server/product-api');
const { createTenantReadRouter } = require('../shared/tenant-read-routes');
const { createRoomUpdateRouter } = require('../shared/room-update-routes');
const { createProductRoomWriteRouter } = require('../shared/product-room-write-routes');
function createHotelApi(dependencies) {
  return createProductApi({ ...dependencies, appId: 'hotel', routes: dependencies.routes || (() => {
    const router = express.Router();
    router.use(createTenantReadRouter({ appId: 'hotel' }));
    router.use(createRoomUpdateRouter('hotel'));
    router.use(createProductRoomWriteRouter('hotel'));
    return router;
  }) });
}
module.exports = { createHotelApi };
