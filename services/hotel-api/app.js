'use strict';
const express = require('express');
const { createProductApi } = require('../../server/product-api');
const { createTenantReadRouter } = require('../shared/tenant-read-routes');
const { createTenantBusinessWriteRouter } = require('../shared/tenant-business-write-routes');
const { createBuildingWriteRouter } = require('../shared/building-write-routes');
const { createRoomUpdateRouter } = require('../shared/room-update-routes');
const { createProductRoomWriteRouter } = require('../shared/product-room-write-routes');
const { createHotelOrderRouter } = require('./order-routes');
const { createBillPaymentRouter } = require('../shared/bill-payment-routes');
function createHotelApi(dependencies) {
  return createProductApi({ ...dependencies, appId: 'hotel', routes: dependencies.routes || (() => {
    const router = express.Router();
    router.use(createTenantReadRouter({ appId: 'hotel' }));
      router.use(createTenantBusinessWriteRouter('hotel'));
    router.use(createBuildingWriteRouter());
    router.use(createRoomUpdateRouter('hotel'));
    router.use(createProductRoomWriteRouter('hotel'));
    router.use(createHotelOrderRouter());
    router.use(createBillPaymentRouter('hotel'));
    return router;
  }) });
}
module.exports = { createHotelApi };
