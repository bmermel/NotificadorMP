/**
 * Compatibilidad: el monitor vive en accountMovementMonitor.js.
 * createTransferMonitor === createAccountMovementMonitor
 */
const { createAccountMovementMonitor, createTransferMonitor } = require("./accountMovementMonitor");

module.exports = {
  createTransferMonitor: createTransferMonitor,
  createAccountMovementMonitor: createAccountMovementMonitor,
};
