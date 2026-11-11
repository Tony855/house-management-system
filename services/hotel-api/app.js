'use strict';
const { createProductApi } = require('../../server/product-api');
const { createTenantReadRouter } = require('../shared/tenant-read-routes');
function createHotelApi(dependencies) { return createProductApi({ ...dependencies, appId: 'hotel', routes: dependencies.routes || (() => createTenantReadRouter({ appId: 'hotel' })) }); }
module.exports = { createHotelApi };
