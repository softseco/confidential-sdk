// Builds the playground into ../docs, which GitHub Pages serves as-is.
//
//   npm install && npm run build
//
// The SDK and Token-2022 import @solana/zk-sdk's Node and bundler builds. In a plain browser page
// neither works, so every @solana/zk-sdk import is pointed at one shim over the web build, and the
// WASM file is copied next to the bundle and loaded once at startup.
import { build } from "esbuild";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../docs");
const shim = path.join(here, "src/zk-shim.js");

const zkWebBuild = {
  name: "zk-sdk-web",
  setup(b) {
    b.onResolve({ filter: /^@solana\/zk-sdk(\/(node|bundler))?$/ }, () => ({ path: shim }));
  },
};

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
  plugins: [zkWebBuild],
  logLevel: "info",
});

await copyFile(path.join(here, "node_modules/@solana/zk-sdk/dist/web/index_bg.wasm"), path.join(out, "zk_sdk_bg.wasm"));
await copyFile(path.join(here, "index.html"), path.join(out, "index.html"));
await copyFile(path.join(here, "logo-mark.svg"), path.join(out, "logo-mark.svg"));
await writeFile(path.join(out, ".nojekyll"), "");

console.log(`built ${path.relative(process.cwd(), out) || "."}`);
