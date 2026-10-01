# Playground

A single page that runs the whole confidential-transfer lifecycle with `@softseco/confidential-transfers`, in the browser, on Solana devnet:

fund → create a confidential mint → deposit → transfer → decrypt → withdraw

Then the same transfer under a rule: a second confidential mint with [Sentinel](https://github.com/softseco/sentinel) as its transfer hook and the blocklist on. A payment to a blocklisted wallet is refused by the chain, and the same payment to Bob goes through, still encrypted.

Live: https://softseco.github.io/confidential-sdk/

The page makes four throwaway keypairs (you, Bob, an auditor, Mallory) and keeps them in `localStorage`. Nothing leaves the browser except signed devnet transactions.

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
- The three Sentinel instructions (meta list, policy, blocklist entry) are built with `@solana/kit` in `src/sentinel.js`, from the Sentinel 2.0.2 IDL. From Node you would use `@softseco/sentinel` instead.
- A transfer the hook refuses stops after its proofs were verified into context accounts. The page finds the ones the wallet still owns and closes them, so the rent comes back.
- Busy RPC? Add `?rpc=https://your-devnet-endpoint` to the URL.
