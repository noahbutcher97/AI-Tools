// Used only as an explicit test preload in disposable CLI and MCP processes.
const fs = require("node:fs");
const write = fs.writeFileSync;
const close = fs.closeSync;
let closeFaultFd;
fs.writeFileSync = function (fd, text, ...options) {
  if (typeof fd !== "number" || typeof text !== "string" || !text.includes("synthetic interrupted record")) {
    return write.call(fs, fd, text, ...options);
  }
  if (process.env.RELAY_TEST_SPOOL_FAULT === "partial") {
    write.call(fs, fd, text.slice(0, text.indexOf("synthetic interrupted") + "synthetic interrupted".length));
    throw new Error("EFBIG fixture");
  }
  write.call(fs, fd, text, ...options);
  closeFaultFd = fd;
};
fs.closeSync = function (fd) {
  close.call(fs, fd);
  if (fd === closeFaultFd) {
    closeFaultFd = undefined;
    throw new Error("synthetic close failure");
  }
};
