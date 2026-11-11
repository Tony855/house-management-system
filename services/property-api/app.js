'use strict';
const { createProductApi } = require('../../server/product-api');
function createPropertyApi(dependencies) { return createProductApi({ ...dependencies, appId: 'property' }); }
module.exports = { createPropertyApi };
