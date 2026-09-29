// The SDK imports the Node build of @solana/zk-sdk, which reads its WASM from disk. In the browser the
// same classes come from the web build, which needs one async init() with the URL of the .wasm file.
// build.mjs points every @solana/zk-sdk import here; app.js awaits initZk() before the first SDK call.
import initWasm from "../node_modules/@solana/zk-sdk/dist/web/index.js";

export * from "../node_modules/@solana/zk-sdk/dist/web/index.js";

let ready;
export function initZk(wasmUrl) {
  ready ??= initWasm({ module_or_path: wasmUrl });
  return ready;
}
