'use strict';
const express = require('express');
const { createProductApi } = require('../../server/product-api');
const { createTenantReadRouter } = require('../shared/tenant-read-routes');
const { createTenantBusinessWriteRouter } = require('../shared/tenant-business-write-routes');
const { createBuildingWriteRouter } = require('../shared/building-write-routes');
const { createRoomUpdateRouter } = require('../shared/room-update-routes');
const { createRentalWriteRouter } = require('./write-routes');
const { createMeterWriteRouter } = require('../shared/meter-write-routes');

const { createBillPaymentRouter } = require('../shared/bill-payment-routes');
function createRentalApi(dependencies) {
  return createProductApi({
    ...dependencies,
    appId: 'rental',
    routes: dependencies.routes || (() => {
      const router = express.Router();
      router.use(createTenantReadRouter({ appId: 'rental' }));
      router.use(createTenantBusinessWriteRouter('rental'));
      router.use(createBuildingWriteRouter());
      router.use(createRoomUpdateRouter('rental'));
      router.use(createRentalWriteRouter());
      router.use(createMeterWriteRouter('rental'));
    router.use(createBillPaymentRouter('rental'));
      return router;
    })
  });
}
module.exports = { createRentalApi };
