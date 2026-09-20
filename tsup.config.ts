// SPDX-License-Identifier: Apache-2.0
//
// Build config. tsup bundles src/index.ts into dual ESM (.mjs) + CJS (.js) output
// with dependencies left external. Type declarations are emitted separately via
// `tsc --emitDeclarationOnly` (more reliable than tsup's bundled dts for the
// dependency types this SDK re-exports).
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  clean: true,
  sourcemap: true,
});
