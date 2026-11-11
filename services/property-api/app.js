'use strict';
const { createProductApi } = require('../../server/product-api');
const { createTenantReadRouter } = require('../shared/tenant-read-routes');
function createPropertyApi(dependencies) { return createProductApi({ ...dependencies, appId: 'property', routes: dependencies.routes || (() => createTenantReadRouter({ appId: 'property' })) }); }
module.exports = { createPropertyApi };
