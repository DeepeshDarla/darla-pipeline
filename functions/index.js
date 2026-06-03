const admin = require('firebase-admin');
admin.initializeApp();

const { processSupplierFile } = require('./processSupplierFile');
exports.processSupplierFile = processSupplierFile;