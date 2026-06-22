# Confidential Transfers SDK

Open-source TypeScript SDK for **Token-2022 Confidential Transfers** on Solana, built on
[`@solana/kit`](https://github.com/anza-xyz/kit) (web3.js v2). It packages ElGamal/AES key
handling, zero-knowledge proof generation, proof-context accounts, and the confidential-transfer
instructions into a handful of clean async functions — so you can add encrypted balances and
private transfers without hand-assembling the primitives.

> **Status: alpha, in active development. Not production-ready.**
> Confidential transfers depend on Solana's ZK ElGamal Proof Program. This SDK is developed and
> tested against a **local validator** running that program plus a client-matching Token-2022
> build (see [Local development](#local-development)). Verify current support on your target
> cluster before using beyond a local validator.

## Features

- **`configureAccount`** — enable a Token-2022 account for confidential transfers (with the PubkeyValidity ZK proof)
- **`deposit`** — move tokens from the public balance into the confidential **pending** balance
- **`applyPendingBalance`** — roll the pending balance into the spendable **available** balance
- **`decryptBalance`** — decrypt your own available balance locally (read-only)
- **`transfer`** — privately transfer an encrypted amount (equality + ciphertext-validity + range proofs, verified via context-state accounts)

Keys are derived deterministically from the account owner's wallet signer and bound to
`(owner, mint)`, so they are recoverable from the wallet alone and never need to be stored. The
derivation matches the reference Rust `solana-zk-sdk` vector.

## Install

```bash
npm install @softseco/confidential-transfers
```

In a Solana app you'll already have the peers this builds on: `@solana/kit` and
`@solana-program/token-2022`.

## Usage

```ts
import {
  configureAccount,
  deposit,
  applyPendingBalance,
  decryptBalance,
  transfer,
} from "@softseco/confidential-transfers";

// 1. enable Alice's account for confidential transfers
const { token } = await configureAccount({ rpc, rpcSubscriptions, payer, owner: alice, mint });

// 2. move 1000 public tokens into Alice's confidential pending balance
await deposit({ rpc, rpcSubscriptions, payer, owner: alice, mint, amount: 1000n, decimals });

// 3. roll pending -> available
await applyPendingBalance({ rpc, rpcSubscriptions, payer, owner: alice, mint });

// 4. read your own balance (decrypted locally; nothing is revealed on-chain)
const balance = await decryptBalance({ rpc, owner: alice, mint }); // 1000n

// 5. privately transfer 1000 to Bob
await transfer({
  rpc,
  rpcSubscriptions,
  payer,
  owner: alice,
  mint,
  destinationOwner: bob.address,
  amount: 1000n,
});
```

A full, runnable round trip lives in
[`examples/confidential-transfer.ts`](./examples/confidential-transfer.ts):

```bash
# with a local validator running (see Local development):
npm run example
```

## API

| Function | Purpose | Notable inputs / output |
|---|---|---|
| `configureAccount` | Configure a Token-2022 account for CT | `rpc`, `rpcSubscriptions`, `payer`, `owner`, `mint` → `{ token, signature }` |
| `deposit` | Public balance → confidential pending | `…`, `amount`, `decimals` → `{ token, signature }` |
| `applyPendingBalance` | Pending → available | `rpc`, `rpcSubscriptions`, `payer`, `owner`, `mint` → `{ token, signature }` |
| `decryptBalance` | Decrypt your available balance (read-only) | `rpc`, `owner`, `mint` → `bigint` |
| `transfer` | Private transfer between accounts | `…`, `owner`, `mint`, `destinationOwner` (or `destinationToken`), `amount` → `{ sourceToken, destinationToken, signatures }` |

Every function accepts an optional `programAddress` (defaults to Token-2022) and derives the
owner's ElGamal/AES keys from the `owner` signer — no key storage required.

## Local development

Confidential-transfer instructions require an on-chain Token-2022 program that **matches the
client**, plus the ZK ElGamal Proof Program. The on-chain tests and the example therefore run
against a local validator:

```bash
# 1. build a Token-2022 program matching the @solana-program/token-2022 client
cargo build-sbf --manifest-path <token-2022-source>/program/Cargo.toml

# 2. start the validator with that program loaded (leave running)
TOKEN_2022_SO=$(find <token-2022-source> -name 'spl_token_2022.so' -path '*deploy*' | head -1) \
  npm run validator

# 3. in another terminal, run the on-chain integration tests
CT_LOCAL_PROGRAM=1 npm test
```

Without `CT_LOCAL_PROGRAM=1` the on-chain tests are skipped and only the validator-free unit
tests run — this is what CI does.

## Roadmap

- Native-Node packaging for `transfer()` (drop the bundler-wasm resolution shim)
- Test coverage ≥ 80% and the `v0.1.0` npm release
- Auditor-key selective disclosure, and a mirroring Rust crate

## License

Apache-2.0. See [LICENSE](./LICENSE).
