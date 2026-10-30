const admin = require('firebase-admin');
const { createHandler } = require('../server/invoice-template.cjs');
module.exports = createHandler(admin);
module.exports.createHandler = createHandler;
