'use strict';
const { createProductApi } = require('../../server/product-api');
function createRentalApi(dependencies) { return createProductApi({ ...dependencies, appId: 'rental' }); }
module.exports = { createRentalApi };
