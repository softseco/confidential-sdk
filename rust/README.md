<!-- SPDX-License-Identifier: Apache-2.0 -->
# softseco-confidential-transfers (Rust)

[![crates.io](https://img.shields.io/crates/v/softseco-confidential-transfers.svg)](https://crates.io/crates/softseco-confidential-transfers)
[![docs.rs](https://img.shields.io/docsrs/softseco-confidential-transfers)](https://docs.rs/softseco-confidential-transfers)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](../LICENSE)

Rust helpers for **SPL Token-2022 Confidential Transfers**, mirroring the
[`@softseco/confidential-transfers`](https://www.npmjs.com/package/@softseco/confidential-transfers)
TypeScript SDK. Built on [`spl-token-client`](https://crates.io/crates/spl-token-client)
and [`solana-zk-sdk`](https://crates.io/crates/solana-zk-sdk).

> **Status: `v1.0.0` — stable API.** The crate mirrors the TypeScript helpers
> (`configure_account`, `deposit`, `transfer`, `apply_pending_balance`,
> `decrypt_balance`) plus auditor-key selective disclosure. **`transfer` is currently
> experimental — see the Note below.** Confidential transfers
> depend on Solana's ZK ElGamal Proof Program; validated against a local validator
> running that program plus a client-matching Token-2022 build.

## Install

```bash
cargo add softseco-confidential-transfers
```

## Usage

```rust
use softseco_confidential_transfers::{
    apply_pending_balance, configure_account, decrypt_balance, deposit, transfer,
    derive_auditor_keypair, decrypt_auditor_amount,
};

// Enable Alice's account, deposit, apply pending, read, then transfer to Bob.
configure_account(rpc_url, payer.clone(), &alice, &mint, decimals).await?;
deposit(rpc_url, payer.clone(), &alice, &mint, 1000, decimals).await?;
apply_pending_balance(rpc_url, payer.clone(), &alice, &mint, decimals).await?;
let balance = decrypt_balance(rpc_url, payer.clone(), &alice, &mint, decimals).await?; // 1000

// Pass Some(auditor_pubkey) for an auditor-enabled mint; None otherwise.
transfer(rpc_url, payer.clone(), &alice, &mint, &bob_pubkey, 1000, decimals, None).await?;
```

Auditor selective disclosure:

```rust
// The auditor derives its ElGamal identity from its own wallet signer.
let auditor = derive_auditor_keypair(&auditor_wallet)?;

// Recover a transfer's amount from its auditor ciphertext (lo/hi halves).
let amount = decrypt_auditor_amount(&auditor, &ciphertext_lo, &ciphertext_hi)?;
```

Keys (`ElGamalKeypair` + `AeKey`) are derived deterministically from the owner's
signer, bound to the token-account address — recoverable from the wallet alone and
never stored. `derive_account_keys` is exported for advanced use.

## API

| Item | Purpose |
|---|---|
| `configure_account` | Configure a Token-2022 account for confidential transfers |
| `deposit` | Move public tokens into the confidential pending balance |
| `apply_pending_balance` | Roll the pending balance into the available balance |
| `decrypt_balance` | Decrypt the account's available balance (read-only) |
| `transfer` | Confidentially transfer to another account |
| `derive_auditor_keypair` | Derive the auditor's ElGamal keypair from its wallet |
| `decrypt_auditor_amount` | Recover a transfer amount from its auditor ciphertext |
| `derive_account_keys` | Derive an account's `(ElGamalKeypair, AeKey)` |

> **⚠️ `transfer` is experimental / unverified.** It generates the three ZK proofs
> **inline**, so the transaction very likely exceeds Solana's size limit for real
> transfers, and the path has **no integration test** yet. The TypeScript SDK uses
> context-state proof accounts (verified and tested); a Rust port is planned. The
> other helpers (`configure_account`, `deposit`, `apply_pending_balance`,
> `decrypt_balance`, and the auditor utilities) are the tested mirror of the TS SDK.

## Build

```bash
cd rust
cargo build
cargo test          # unit tests
```

Confidential transfers require a local validator running the ZK ElGamal Proof
Program plus a client-matching Token-2022 build for the on-chain integration
tests (see the repository root [README](../README.md) and
[CONTRIBUTING](../CONTRIBUTING.md)).

## License

Apache-2.0.
