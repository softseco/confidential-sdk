<!-- SPDX-License-Identifier: Apache-2.0 -->
# softseco-confidential-transfers (Rust)

Rust helpers for **SPL Token-2022 Confidential Transfers**, mirroring the
[`@softseco/confidential-transfers`](https://www.npmjs.com/package/@softseco/confidential-transfers)
TypeScript SDK. Built on [`spl-token-client`](https://crates.io/crates/spl-token-client)
and [`solana-zk-sdk`](https://crates.io/crates/solana-zk-sdk).

> **Status: alpha, in active development.** Part of Milestone 2 — the crate
> mirrors the TS helpers (`configure_account`, `deposit`, `transfer`,
> `apply_pending_balance`, `decrypt_balance`) plus auditor-key selective
> disclosure. Helpers are landing incrementally.

## Build

```bash
cd rust
cargo build
cargo test          # unit tests
```

Confidential transfers require a local validator running the ZK ElGamal Proof
Program plus a client-matching Token-2022 build for the on-chain integration
tests (see the repository root README).

## License

Apache-2.0.
