'use strict';
const { createProductApi } = require('../../server/product-api');
function createHotelApi(dependencies) { return createProductApi({ ...dependencies, appId: 'hotel' }); }
module.exports = { createHotelApi };
