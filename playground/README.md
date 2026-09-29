# Playground

A single page that runs the whole confidential-transfer lifecycle with `@softseco/confidential-transfers`, in the browser, on Solana devnet:

fund → create a confidential mint → deposit → transfer → decrypt → withdraw

Live: https://softseco.github.io/confidential-sdk/

The page makes three throwaway keypairs (you, Bob, an auditor) and keeps them in `localStorage`. Nothing leaves the browser except signed devnet transactions.

## Build

```bash
cd playground
npm install
npm run build   # writes ../docs (index.html, app.js, zk_sdk_bg.wasm)
```

Serve `../docs` with any static server to try it locally, e.g. `npx serve ../docs`.

## Notes

- `@solana/zk-sdk` ships Node, bundler and web builds. The SDK imports the Node build; the page swaps every `@solana/zk-sdk` import for the web build (`src/zk-shim.js`) and loads the WASM once at startup.
- Transactions are confirmed by polling the HTTP RPC (`src/polling.js`) instead of a websocket, because the public devnet websocket drops connections under load.
- Busy RPC? Add `?rpc=https://your-devnet-endpoint` to the URL.
