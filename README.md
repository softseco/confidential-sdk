# Confidential Transfers SDK

[![npm version](https://img.shields.io/npm/v/@softseco/confidential-transfers.svg)](https://www.npmjs.com/package/@softseco/confidential-transfers)
[![crates.io](https://img.shields.io/crates/v/softseco-confidential-transfers.svg)](https://crates.io/crates/softseco-confidential-transfers)
[![CI](https://github.com/softseco/confidential-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/softseco/confidential-sdk/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

Open-source TypeScript SDK for **Token-2022 Confidential Transfers** on Solana, built on
[`@solana/kit`](https://github.com/anza-xyz/kit) (web3.js v2). It packages ElGamal/AES key
handling, zero-knowledge proof generation, proof-context accounts, and the confidential-transfer
instructions into a handful of clean async functions — so you can add encrypted balances and
private transfers without hand-assembling the primitives.

A Rust crate mirroring the same helpers is published alongside it — see [Rust](#rust).

> **Status: `v1.0.0` — stable API.** The public surface follows [semantic versioning](https://semver.org);
> breaking changes will bump the major version. Confidential transfers depend on Solana's ZK ElGamal
> Proof Program: this SDK is developed and validated against a **local validator** running that program
> plus a client-matching Token-2022 build (see [Local development](#local-development)). Verify current
> support on your target cluster before deploying beyond a local validator. Runtime: **Node ≥ 20**.

## Features

- **`configureAccount`** — enable a Token-2022 account for confidential transfers (with the PubkeyValidity ZK proof)
- **`deposit`** — move tokens from the public balance into the confidential **pending** balance
- **`applyPendingBalance`** — roll the pending balance into the spendable **available** balance
- **`decryptBalance`** — decrypt your own available balance locally (read-only)
- **`transfer`** — privately transfer an encrypted amount (equality + ciphertext-validity + range proofs, verified via context-state accounts)
- **Auditor selective disclosure** — derive an auditor ElGamal identity and recover transfer amounts on an auditor-enabled mint, without the power to spend

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

### Auditor selective disclosure

A mint can designate an **auditor** ElGamal public key. Once set, every confidential transfer on
that mint additionally encrypts the amount to the auditor, who — and only who — can recover it,
without being able to spend and without weakening anyone else's confidentiality.

```ts
import {
  deriveAuditorElgamalKeypair,
  getAuditorElgamalPubkey,
  decryptTransferAmountAsAuditor,
} from "@softseco/confidential-transfers";

// The auditor derives its ElGamal identity from its own wallet (nothing stored):
const auditorKeypair = await deriveAuditorElgamalKeypair(auditorWallet);

// Its public key goes into the mint's confidential-transfer config at mint creation:
const auditorElgamalPubkey = getAuditorElgamalPubkey(auditorKeypair);

// Senders route transfers to the auditor by passing that pubkey:
await transfer({ rpc, rpcSubscriptions, payer, owner: alice, mint, destinationOwner: bob.address, amount: 1000n, auditorElgamalPubkey });

// Given a confirmed transfer's signature, the auditor recovers the amount:
const amount = await decryptTransferAmountAsAuditor({ rpc, signature, auditorKeypair }); // 1000n
```

## API

| Function | Purpose | Notable inputs / output |
|---|---|---|
| `configureAccount` | Configure a Token-2022 account for CT | `rpc`, `rpcSubscriptions`, `payer`, `owner`, `mint` → `{ token, signature }` |
| `deposit` | Public balance → confidential pending | `…`, `amount`, `decimals` → `{ token, signature }` |
| `applyPendingBalance` | Pending → available | `rpc`, `rpcSubscriptions`, `payer`, `owner`, `mint` → `{ token, signature }` |
| `decryptBalance` | Decrypt your available balance (read-only) | `rpc`, `owner`, `mint` → `bigint` |
| `transfer` | Private transfer between accounts | `…`, `owner`, `mint`, `destinationOwner` (or `destinationToken`), `amount`, optional `auditorElgamalPubkey` → `{ sourceToken, destinationToken, signatures }` |
| `deriveAuditorElgamalKeypair` | Derive the auditor's ElGamal keypair from its wallet | `signer` → `ElGamalKeypair` |
| `getAuditorElgamalPubkey` | Auditor pubkey for a mint's CT config | `auditorKeypair` → `Address` |
| `decryptTransferAmountAsAuditor` | Recover a transfer's amount as the auditor | `rpc`, `signature`, `auditorKeypair` → `bigint` |

Every function accepts an optional `programAddress` (defaults to Token-2022) and derives the
owner's ElGamal/AES keys from the `owner` signer — no key storage required.

## Rust

The same helpers — the five core operations plus the auditor utilities — are published as a Rust
crate, [`softseco-confidential-transfers`](https://crates.io/crates/softseco-confidential-transfers):

```bash
cargo add softseco-confidential-transfers
```

Built on [`solana-zk-sdk`](https://crates.io/crates/solana-zk-sdk) and
[`spl-token-client`](https://crates.io/crates/spl-token-client). See [`rust/README.md`](./rust/README.md)
for the crate API and details.

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
tests run — this is what CI does. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

## Project status

`v1.0.0` — the public API is stable. Both the TypeScript package and the Rust crate ship the five
core operations plus auditor selective disclosure, each with CI. Changes are tracked in
[CHANGELOG.md](./CHANGELOG.md).

Planned next:

- Broaden cluster coverage as the ZK ElGamal Proof Program rolls out beyond local validators
- A Rust integration-test suite against a local validator
- Additional worked examples (end-to-end auditor flow, multi-party transfers)

## Security

Confidential transfers are cryptographic and security-sensitive. To report a vulnerability, see
[SECURITY.md](./SECURITY.md) — please do not open a public issue for security reports.

## License

Apache-2.0. See [LICENSE](./LICENSE).
