// SPDX-License-Identifier: Apache-2.0
//
// Browser flavour of ./zk.ts, swapped in by the browser build (tsup.config.ts). The web build of
// @solana/zk-sdk needs one async init() that fetches its WebAssembly; every SDK function awaits
// `ensureZk()` first, so applications do not have to.
import initWasm from "@solana/zk-sdk/web";

export * from "@solana/zk-sdk/web";

export type InitConfidentialTransfersOptions = {
  wasmUrl?: string | URL;
};

let loading: Promise<void> | undefined;
let loaded = false;

export function initConfidentialTransfers(options?: InitConfidentialTransfersOptions): Promise<void> {
  loading ??= initWasm(options?.wasmUrl ? { module_or_path: options.wasmUrl } : undefined).then(
    () => {
      loaded = true;
    },
    (error: unknown) => {
      loading = undefined;
      throw new Error(
        "@softseco/confidential-transfers could not load the zk-sdk WebAssembly (index_bg.wasm from " +
          "@solana/zk-sdk/dist/web). With Vite's dev server, add " +
          '`optimizeDeps: { exclude: ["@solana/zk-sdk"] }` to vite.config, and if the request for the ' +
          ".wasm file is refused (403), add its node_modules folder to `server.fs.allow`. Or serve the " +
          "file yourself and pass its URL: `initConfidentialTransfers({ wasmUrl })`. Cause: " +
          String(error),
      );
    },
  );
  return loading;
}

export function ensureZk(): Promise<void> {
  return initConfidentialTransfers();
}

export function assertZkReady(what: string): void {
  if (!loaded) {
    throw new Error(
      `${what} needs the zk-sdk WebAssembly, which is not loaded yet. ` +
        "Call `await initConfidentialTransfers()` once before using it in a browser.",
    );
  }
}
