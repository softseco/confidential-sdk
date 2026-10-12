// Builds the playground into ../docs, which GitHub Pages serves as-is.
//
//   npm install && npm run build
//
// esbuild picks the SDK's browser build (the "browser" export condition), which uses
// @solana/zk-sdk's web build. esbuild does not copy the WebAssembly that build loads, so it is
// copied next to the bundle here and app.js passes its URL to initConfidentialTransfers().
import { build } from "esbuild";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../docs");
await mkdir(out, { recursive: true });

await build({
  entryPoints: [path.join(here, "src/app.js")],
  outfile: path.join(out, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  logLevel: "info",
});

await copyFile(path.join(here, "node_modules/@solana/zk-sdk/dist/web/index_bg.wasm"), path.join(out, "zk_sdk_bg.wasm"));
await copyFile(path.join(here, "index.html"), path.join(out, "index.html"));
await copyFile(path.join(here, "logo-mark.svg"), path.join(out, "logo-mark.svg"));
await copyFile(path.join(here, "og.png"), path.join(out, "og.png"));
await writeFile(path.join(out, ".nojekyll"), "");

console.log(`built ${path.relative(process.cwd(), out) || "."}`);
