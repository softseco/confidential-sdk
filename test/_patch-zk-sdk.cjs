// The @solana-program/token-2022 confidential-transfer helper hardcodes the
// `bundler` build of @solana/zk-sdk, whose JS does `require('<file>.wasm')` — Node
// (and tsx) cannot load a .wasm file that way, so it throws a SyntaxError. The
// `node` build exposes the same API but loads its WASM via fs, so we remap the
// subpath at the module-resolution level. This also keeps every zk-sdk object on a
// single WASM instance, matching the rest of the SDK.
const Module = require("module");
const FROM = "@solana/zk-sdk/bundler";
const TO = "@solana/zk-sdk/node";
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolveFilename.call(this, request === FROM ? TO : request, ...rest);
};
