<!-- SPDX-License-Identifier: Apache-2.0 -->
# softseco-confidential-transfers (Rust)

[![crates.io](https://img.shields.io/crates/v/softseco-confidential-transfers.svg)](https://crates.io/crates/softseco-confidential-transfers)
[![docs.rs](https://img.shields.io/docsrs/softseco-confidential-transfers)](https://docs.rs/softseco-confidential-transfers)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](../LICENSE)

**SPL Token-2022 confidential transfers** in Rust: encrypted balances and encrypted transfer
amounts, in a few calls. The Rust twin of the
[`@softseco/confidential-transfers`](https://www.npmjs.com/package/@softseco/confidential-transfers)
TypeScript SDK, with the same keys, the same checks and the same error codes.

> **Status: `v3.0.0`.** Configure, deposit, apply, read, transfer and withdraw; mints with an
> auditor and mints with a transfer hook; cleanup when a transfer fails partway; accounts owned
> by a program (with a complete Anchor example). Tested end to end on a local validator with
> Token-2022 v11.1, including transfers through the [Sentinel](https://github.com/softseco/sentinel)
> transfer hook.

## Install

```bash
cargo add softseco-confidential-transfers
```

## Usage

```rust
use std::sync::Arc;
use solana_client::{nonblocking::rpc_client::RpcClient, rpc_config::CommitmentConfig};
use softseco_confidential_transfers::ConfidentialClient;

let rpc = Arc::new(RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed()));
let client = ConfidentialClient::new(rpc, Arc::new(payer)).with_compute_unit_price(10_000);

client.configure_account(&alice, &mint).await?;            // creates the account if needed
client.deposit(&alice, &mint, 1_000).await?;               // public -> confidential (pending)
client.apply_pending_balance(&alice, &mint).await?;        // pending -> available
client.transfer(&alice, &mint, &bob.pubkey(), 400).await?; // amount encrypted end to end
client.withdraw(&alice, &mint, 100).await?;                // confidential -> public
let balance = client.decrypt_balance(&alice, &mint).await?; // 500
```

The `payer` pays every fee and the temporary rent of the proof accounts, and gets the rent back.
Owners sign their own operations.

What the client takes care of:

- **Proofs.** A transfer needs three zero-knowledge proofs, too large to travel with it. They are
  verified into temporary proof accounts first (four transactions), and the transfer closes them
  in its own transaction. A withdraw is the same with two proofs.
- **Failures partway.** If a step fails after proof accounts were created, the client closes them
  and the error says which step failed and which accounts were closed (`Error::step`,
  `Error::proof_accounts`). `recover_proof_accounts()` closes any left behind by a process that
  stopped.
- **Checks before signing.** A missing or unconfigured account, a recipient that does not accept
  confidential transfers or whose pending balance is full, more than the balance, more than one
  transfer can carry: each fails with its own `ErrorCode` before anything is sent.
- **The mint's auditor key** is read from the mint, and every amount is encrypted to it.
- **Transfer hooks.** The accounts a mint's hook needs are resolved and passed along.
- **Priority fees** (`with_compute_unit_price`) on every transaction that has room, and resending
  after an expired blockhash (`with_max_retries`).

### Errors

Every function returns `softseco_confidential_transfers::Result`. `Error::code()` is an
`ErrorCode` with the same meaning as the TypeScript SDK's codes (`ErrorCode::as_str` gives the
TypeScript spelling, e.g. `"PENDING_BALANCE_LIMIT"`):

```rust
if let Err(e) = client.transfer(&alice, &mint, &bob, amount).await {
    match e.code() {
        ErrorCode::PendingBalanceLimit => { /* Bob has to apply his pending balance first */ }
        _ if e.is_retryable() => { /* the blockhash expired: run it again */ }
        _ => return Err(e.into()),
    }
}
```

### Auditor

```rust
let auditor = derive_auditor_keypair(&auditor_wallet)?;          // from the auditor's wallet
let amount = decrypt_auditor_amount(&auditor, &lo, &hi)?;        // from a transfer's ciphertexts
```

For a report of every transfer of a mint, the TypeScript package has
`listConfidentialActivity` and an `audit-report` command.

### Accounts owned by a program

A token account owned by a PDA cannot sign the key-derivation message, and a program cannot
generate proofs. So an operator derives the account's keys with
`ConfidentialKeys::derive_for_pda_wallet`, the client prepares each step, and the program makes the
Token-2022 call through CPI:

| Client | Program |
|---|---|
| `prepare_configure(&keys)` | `ConfigureAccount` with the proof account |
| `pending_balance_update(&mint, &token, &keys)` | `ApplyPendingBalance` |
| `prepare_transfer(&mint, &token, &keys, &destination, amount)`, `transfer_hook_accounts(..)` | `Transfer` with the three proof accounts |
| `prepare_withdraw(&mint, &token, &keys, amount)` | `Withdraw` with the two proof accounts |
| `close_proof_accounts(..)` afterwards | |

[`examples/anchor-vault`](./examples/anchor-vault) is a complete Anchor program built this way: a
vault that receives confidential transfers and pays out of its confidential balance, through a
transfer hook, with the mint's auditor reading every payout.

### Keys

Keys come from the owner's wallet with the standard derivation: one signature over
`solana-conf-bal/v1`, the same keys for every mint and account the wallet owns, recoverable and
never stored, and identical to what the TypeScript SDK, the spl-token CLI and other standard
clients derive. `ConfidentialKeys::derive(&wallet)` gives them directly. The bytes are pinned by
[shared test vectors](../test-vectors) that both SDKs check.

## Upgrading from 2.x

The 2.x free functions (`configure_account(rpc_url, payer, owner, mint, decimals)` and so on)
still work in 3.0, deprecated: each now goes through `ConfidentialClient`. Differences:

- They return this crate's `Error` instead of `Box<dyn Error>`; `?` into `Box<dyn Error>` still
  works.
- `transfer` ignores its `auditor_elgamal_pubkey` argument and reads the key from the mint.
- `decimals` is read from the mint; the argument is ignored.

`derive_account_keys` and the auditor functions keep their names and return `Result` with the new
error. Accounts and keys are unchanged.

## Build and test

```bash
cd rust
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test                     # unit tests and the shared vectors; on-chain tests skip
```

The on-chain tests need a local validator from Agave 4.x with the Token-2022 build in
[`test/fixtures`](../test/fixtures) (and Sentinel, for the transfer-hook test):

```bash
TOKEN_2022_SO=test/fixtures/spl_token_2022.so SENTINEL_SO=test/fixtures/sentinel.so \
  bash scripts/start-test-validator.sh            # from the repository root
cd rust && CT_LOCAL_PROGRAM=1 cargo test -- --test-threads 1
```

Dependencies are pinned with `=` to the set `spl-token-client` 0.19.1 resolves to; bump them
together or not at all.

## License

Apache-2.0.
