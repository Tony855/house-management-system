'use strict';
const { createProductApi } = require('../../server/product-api');
const { createTenantReadRouter } = require('../shared/tenant-read-routes');
function createRentalApi(dependencies) { return createProductApi({ ...dependencies, appId: 'rental', routes: dependencies.routes || (() => createTenantReadRouter({ appId: 'rental' })) }); }
module.exports = { createRentalApi };
