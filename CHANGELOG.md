# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This repository holds the TypeScript package
([`@softseco/confidential-transfers`](https://www.npmjs.com/package/@softseco/confidential-transfers))
and the Rust crate
([`softseco-confidential-transfers`](https://crates.io/crates/softseco-confidential-transfers)).
Up to 2.0.0 they were released together under one version. Since 2.1.0 each has its own versions:
the TypeScript package is tagged `vX.Y.Z`, the Rust crate `rust-vX.Y.Z` (its entries below are
headed `rust-X.Y.Z`).

## [Unreleased]

### Changed

- `package.json` writes the `bin` path as npm normalizes it (`dist/cli.js`), so `npm publish` no
  longer warns.

### Tests

- Shared test vectors with the Rust crate (`test-vectors/confidential-transfers.json`): key
  derivation, the PDA-wallet seed, an auditor's transfer amount and an AES balance, checked by
  both test suites.

## [rust-3.0.0] - 2026-10-12

The Rust crate catches up with the TypeScript SDK. Breaking: a client type replaces the free
functions, which stay for now as deprecated wrappers.

### Added

- `ConfidentialClient` over an `Arc<RpcClient>` and a payer: `configure_account`, `deposit`,
  `apply_pending_balance`, `decrypt_balance`, `transfer` and, new, **`withdraw`**.
- **Transfer hooks.** `transfer` resolves the accounts a mint's hook needs and passes them along.
  Tested with Sentinel as the hook, refusing and then allowing a confidential transfer.
- **Cleanup when a transfer or withdraw fails partway**: the proof accounts created so far are
  closed, and the error names the step and the accounts (`Error::step`, `Error::proof_accounts`).
  `recover_proof_accounts()` closes any left by a process that stopped. On success the proof
  accounts are closed in the transfer's own transaction.
- **Checks before signing**, with the TypeScript SDK's error codes: `Error` and `ErrorCode`
  (`ACCOUNT_NOT_FOUND`, `ACCOUNT_NOT_CONFIGURED`, `PENDING_BALANCE_LIMIT`, `INSUFFICIENT_FUNDS`,
  `AMOUNT_TOO_LARGE`, `KEYS_MISMATCH`, ...). Every transaction is simulated first, so a failure
  comes with the program logs.
- Priority fees (`with_compute_unit_price`) and resending after an expired blockhash
  (`with_max_retries`).
- **Accounts owned by a program**: `ConfidentialKeys::derive_for_pda_wallet` and
  `pda_wallet_public_seed` (the TypeScript SDK's convention), and `prepare_configure`,
  `prepare_transfer`, `prepare_withdraw`, `pending_balance_update`, `transfer_hook_accounts`,
  `close_proof_accounts`, so a program can make the Token-2022 calls through CPI.
- `examples/anchor-vault`: an Anchor program that holds a confidential balance in a PDA-owned
  account and pays out of it, through a transfer hook, with the mint's auditor reading each payout.
  Tested on a local validator.
- `ConfidentialKeys` (`derive`, `derive_with_seed`); key derivation now checks that the signature
  verifies.

### Changed

- `transfer` reads the mint's auditor key itself; the 2.x `transfer` ignores its
  `auditor_elgamal_pubkey` argument.
- Errors are this crate's `Error` instead of `Box<dyn Error>`.
- The 2.x free functions are deprecated wrappers over `ConfidentialClient`; `decimals` is read from
  the mint.

### Tests

- On-chain tests (gated by `CT_LOCAL_PROGRAM=1`): the full flow with an auditor, a priority fee and
  a withdraw; every check before signing; a transfer through Sentinel; recovery of proof accounts;
  the Anchor example. The shared test vectors replace the single pinned vector. CI runs them on a
  local validator with Token-2022 v11.1, Sentinel 2.1.0 and the example program.

## [3.3.0] - 2026-10-12

For auditors. No breaking changes.

### Added

- `listConfidentialActivity({ rpc, mint, auditorKeypair })` reads a mint's transaction history and
  lists every deposit, confidential transfer and withdraw, oldest first, with the transferred
  amounts decrypted with the auditor key. It finds the instructions inside other programs' calls
  too, works with transactions built by any client, skips failed transactions, and takes
  `since`, `until`, `maxTransactions` and `concurrency`. It checks that the key is the mint's
  auditor key (`KEYS_MISMATCH` otherwise; `skipAuditorKeyCheck` lists what the key can read).
- `confidentialActivityToCsv(activity, { decimals })`: the list as CSV (RFC 4180, UTC times).
- A command line: `npx @softseco/confidential-transfers audit-report --mint … --keypair … --rpc …`
  writes the report as CSV, with the auditor key derived from the auditor's wallet file.
- A guide for auditors (`guides/auditors.md`), also in the API reference.

### Changed

- `transfer` reads the mint's auditor key itself when `auditorElgamalPubkey` is not given. Before,
  a transfer on a mint with an auditor failed on chain unless the caller passed the key.

## [3.2.0] - 2026-10-12

Reliability, for mainnet. No breaking changes for code that awaits these functions and handles a
thrown error; see Changed for what is different.

### Added

- **One wallet prompt per operation.** `transfer` (five transactions) and `withdraw` (four) plan
  all their transactions first and have each signer sign them together, so a browser wallet asks
  once instead of five or four times. They are then sent in order, each simulated first.
- **Cleanup when a step fails halfway.** If a transaction fails before the transfer or withdraw
  itself lands (in simulation, on chain, or because it expired), the proof accounts already
  created are closed again and their rent returned to the payer. The error says which step failed
  (`step`: `"proofs"` or the operation), which transactions landed, and which proof accounts were
  closed or left open.
- `recoverProofAccounts({ rpc, rpcSubscriptions, authority })` finds proof accounts a stopped
  process left behind (the authority is the payer of the transfer) and closes them.
- **Typed errors.** Everything the SDK throws on purpose is a `ConfidentialTransfersError` with a
  `code` (`INSUFFICIENT_FUNDS`, `PENDING_BALANCE_LIMIT`, `ACCOUNT_NOT_FOUND`,
  `ACCOUNT_NOT_CONFIGURED`, `KEYS_MISMATCH`, `TRANSACTION_FAILED`, `TRANSACTION_EXPIRED` and
  others), `operation`, program `logs` when there are any, and `retryable`.
  `isConfidentialTransfersError(error, code?)` checks it.
- **Checks before signing.** `deposit` and `transfer` check that the account (for a transfer, the
  recipient's) exists, is configured and approved, accepts confidential credits and has room for
  one more pending credit, and that the amount fits (at most 2^48 - 1 per deposit or transfer) and
  is covered. A doomed operation now fails before a wallet opens.
- `computeUnitPrice` on every sending function: a priority fee in micro-lamports per compute unit,
  added to each transaction that has room for it. (The range-proof transaction of a transfer is too
  full to take one.)
- `retries` on every sending function: run the operation again when a transaction expires before
  it is confirmed. Default 0, since a retry signs new transactions and a wallet asks again.
- `examples/mainnet.ts` (`npm run example:mainnet`): checks in a free simulation that mainnet's ZK
  ElGamal Proof Program accepts the SDK's proofs and, with `--send`, runs the whole flow with a
  test token and tiny amounts (about 0.01 SOL, mostly rent).

### Changed

- Errors are `ConfidentialTransfersError` instead of plain `Error` (still `instanceof Error`, with
  the same kind of message). Calls that used to fail in simulation now fail earlier with a specific
  code: `configureAccount` on a configured account (`ACCOUNT_ALREADY_CONFIGURED`), `deposit` into
  an unconfigured account (`ACCOUNT_NOT_CONFIGURED`), a transfer to a missing account
  (`ACCOUNT_NOT_FOUND`).
- `transfer` and `deposit` refuse an amount of zero.
- `transfer` and `withdraw` results have `proofAccountsLeftOpen`, normally empty.
- `applyPendingBalance` explains when the pending balance cannot be decrypted because incoming
  amounts add up to more than about 2^48 base units (`DECRYPTION_FAILED`), instead of passing on
  the zk-sdk's error.

## [3.1.0] - 2026-10-12

Web apps. No breaking changes: code written for 3.0 works unchanged.

### Added

- **Browser build.** The package has a second build for browsers (`dist/browser`), selected by the
  `browser` export condition, so Vite, webpack 5 and other bundlers use it with no alias. It loads
  `@solana/zk-sdk`'s WebAssembly on first use. The bundler alias the 3.0.1 README described is no
  longer needed.
- `initConfidentialTransfers({ wasmUrl? })` starts loading the WebAssembly early, or loads it from
  a URL you serve. In Node it does nothing.
- **Browser wallets.** Key derivation accepts any kit `MessageSigner`, including the
  `MessageModifyingSigner` that `@solana/wallet-account-signer` makes from a Wallet Standard
  wallet. The signature is verified against the wallet's address, and a wallet that changes the
  message is refused, since the keys would then differ from the standard ones. A signer that
  cannot sign messages gets an error that says so.
- **`keys` option** on `configureAccount`, `applyPendingBalance`, `decryptBalance`, `transfer` and
  `withdraw`: pass the keys from `deriveConfidentialKeys` and the call does not ask the wallet to
  sign again. A web app asks once per session.
- Before decrypting or building a proof, `applyPendingBalance`, `decryptBalance`, `transfer` and
  `withdraw` check that the keys match the account's ElGamal key, and fail with a clear error if
  not.
- `examples/vite`: a web app (connect a wallet, unlock, set up, deposit, apply, send, withdraw).
- A guide for web apps (`guides/web-apps.md`) and an API reference generated with TypeDoc, at
  https://softseco.github.io/confidential-sdk/api/.
- CI runs the on-chain integration tests and a browser test on a local Agave 4.2 validator: the
  Vite example in Chromium with a Wallet Standard test wallet, through the whole flow, on the
  production build and the dev server. The Token-2022 build the tests need is in
  `test/fixtures/` (v11.1.0, with its hash and how to rebuild it).

### Changed

- `owner` is typed `TransactionSigner` (was `TransactionSigner & MessagePartialSigner`), and
  `decryptBalance`'s `owner` can also be a `MessageSigner`; whether the owner can sign messages is
  checked when keys are needed. `deriveAuditorElgamalKeypair` and the `derive*` key functions take
  a `MessageSigner`. Every value accepted before is still accepted.
- `applyPendingBalance`, `decryptBalance`, `transfer` and `withdraw` read the account before
  asking for the key signature, so a missing or unconfigured account fails before the wallet is
  bothered.

## [3.0.1] - 2026-10-12

Documentation only. No code changes: the published `dist/` is built from the same source as 3.0.0.

### Changed

- The README on npm now links the [browser playground](https://softseco.github.io/confidential-sdk/),
  which runs the whole flow on devnet in a browser tab.
- The README explains how to use the SDK in a browser today (one bundler alias from
  `@solana/zk-sdk/node` to its web build) instead of saying it does not run there.
- The auditor example imports `transfer`, which it calls.

## [3.0.0] - 2026-09-28

### Changed

- **BREAKING: built on `@solana/kit` 8** (was 6), with `@solana-program/token-2022` 0.19,
  `@solana-program/zk-elgamal-proof` 0.4, `@solana-program/system` 0.15 and `@solana/sysvars` 8.
- **`@solana/kit` is now a peer dependency** (`^8.3.0`). With kit as a regular dependency, an app
  on kit 8 got a second, nested copy of kit 6, and every call failed type-checking because the
  app's `Rpc` and `RpcSubscriptions` were not assignable to the SDK's. Now the app and the SDK
  share one copy.
- A clean `npm install` no longer prints peer-dependency warnings, and the repository no longer
  needs `legacy-peer-deps` (`.npmrc` removed).
- Requires Node ≥ 20.18 (the minimum for `@solana/kit` 8).

### Added

- `withdraw()` moves tokens from the confidential available balance back to the public balance.
  It generates the ciphertext-commitment equality proof and a U64 range proof on the remaining
  balance, verifies both into context-state accounts, runs the withdraw and closes the proof
  accounts. Run end-to-end on devnet.
- `examples/devnet.ts` now includes a withdraw step and runs with `npm run example:devnet`. The
  README explains how to try the SDK on devnet in a few commands.
- `npm run typecheck` also type-checks the examples, so they cannot drift from the API unnoticed.
- Package keywords, homepage and issue tracker in `package.json`.

### Migration from 2.x

Move your app to `@solana/kit` 8. Function signatures and key derivation are unchanged, so
accounts configured with 2.x keep working.

### Notes

- The Rust crate is unchanged at 2.0.0. It has no `withdraw`, and its `transfer` does not resolve
  transfer-hook accounts.

## [2.1.0] - 2026-09-23

### Added

- `transfer()` now resolves a mint's transfer-hook accounts and appends them to the confidential
  transfer instruction. Token-2022 invokes the hook on a confidential transfer with an amount of
  `u64::MAX`, and without those accounts the transfer fails with `MissingAccount`. Mints without a
  transfer hook are unaffected.
- `resolveTransferHookAccounts`, `getTransferHookProgram` and `findExtraAccountMetaListPda` are
  exported for callers that build their own instructions.

### Notes

- The Rust crate is unchanged at 2.0.0.

## [2.0.0] - 2026-09-19

### Changed
- **BREAKING — key derivation now follows the ecosystem standard.** Both the TypeScript package
  and the Rust crate derive the ElGamal and AES keys from a single signature over the constant
  message `solana-conf-bal/v1`, expanded through HKDF-SHA512 (`ConfidentialKeys` in
  `@solana/zk-sdk`, `derive_confidential_keys` in `solana-zk-sdk`). Keys are bound to the signing
  wallet alone — one ElGamal keypair and one AES key across every mint and token account — and are
  byte-identical to what the Token-2022 clients and every other standard client derive for the
  same wallet.
- **TypeScript** — requires `@solana/zk-sdk` >= 0.5.3, which replaces the per-key
  `ElGamalKeypair.signerMessage` / `AeKey.signerMessage` derivation with the unified
  `ConfidentialKeys` API.
- **Rust** — requires `solana-zk-sdk` 7, where `encryption::derivation` lives, together with
  `spl-token-client` 0.19.1 and `spl-token-confidential-transfer-proof-generation` 0.6.1. All
  three move as a set: the 0.19.0 and 0.6.0 releases are built against `solana-zk-sdk` 6, and a
  graph holding two majors compiles but does not type-check, because `ElGamalKeypair` from one
  major is a different type from `ElGamalKeypair` in the other.

### Fixed
- **The two language bindings derived different keys.** TypeScript seeded the derivation with the
  64-byte tuple `(owner, mint)`; Rust seeded it with the 32-byte token account address. An account
  configured with one binding therefore could not be read with the other, and neither matched the
  spl-token CLI. The existing cross-language test compared the two implementations at the
  primitive level — the same signer and the same explicit seed — so it passed while the two halves
  fed that primitive different seeds. Found in review, before any mainnet use.

### Added
- `deriveConfidentialKeys({ signer })` — the standard derivation, one signature for both keys.
- `deriveConfidentialKeysWithSeed({ signer, publicSeed })` — explicitly non-standard, seed-scoped
  derivation for schemes that need keys scoped more finely than the wallet.
- `pdaWalletPublicSeed({ programId, walletPda, mint, tokenAccount })` — the canonical seed for
  single-signer PDA wallets, so PDA and passkey wallets share one convention.
- `getElGamalPubkeyAddress(keypair)` — an ElGamal public key as an `Address`.
- Tests that pin the derivation message bytes, pin a standard-derivation vector, and assert that
  every derivation helper in the package agrees — the drift above cannot recur silently.

### Removed
- `deriveConfidentialKeypairs`, `deriveElGamalKeypairForOwnerMint` and `deriveAeKeyForOwnerMint`.
  They are not deprecated wrappers, because a wrapper that ignored its own `owner` and `mint`
  arguments would silently return different keys than 1.x did. `deriveElGamalKeypair` and
  `deriveAeKey` remain but no longer take a `publicSeed`.

### Migration
Keys derived by 1.x and 2.0 are different. There is no in-place migration, because the on-chain
account stores the ElGamal public key that the old derivation produced. Apply the pending balance
of a 1.x account and move its available balance out with a 1.x `transfer` to an account
configured with 2.0. (Neither 1.x nor 2.0 had a `withdraw`; it arrived in 3.0.0.)

## [1.0.1] - 2026-07-14

### Fixed
- **TypeScript** — `transfer` now rejects amounts above the confidential-transfer maximum
  (`2^48 - 1`) with a clear error instead of producing an invalid range proof. Found in a
  self-audit; covered by a unit test.
- **Rust** — `transfer` no longer builds an oversized transaction. Its three ZK proofs are now
  verified into temporary **context-state accounts** (closed afterwards to reclaim rent), mirroring
  the TypeScript SDK, so the transfer transaction fits Solana's 1232-byte limit. The previous inline
  proofs produced a ~3308-byte transaction that always failed. Covered by a gated Rust integration
  test (`rust/tests/ct_integration.rs`).

## [1.0.0] - 2026-07-13

First stable release. No functional changes to the API surface over `0.2.0`; this release commits
to that surface under semantic versioning.

### Added
- Documentation overhaul: auditor selective disclosure is now documented in the main README
  (Features, Usage, and API), with status badges (npm, crates.io, CI, license).
- Cross-links between the TypeScript package and the Rust crate.
- `CHANGELOG.md`, `CONTRIBUTING.md`, and `SECURITY.md`.

### Changed
- Marked the public API stable (`1.0.0`). Breaking changes will bump the major version.
- Refreshed the project status/roadmap to reflect completed work.

## [0.2.0]

### Added
- **Auditor-key selective disclosure** in both packages:
  - TypeScript: `deriveAuditorElgamalKeypair`, `getAuditorElgamalPubkey`,
    `decryptTransferAmountAsAuditor`, and an optional `auditorElgamalPubkey` on `transfer`.
  - Rust: `derive_auditor_keypair`, `decrypt_auditor_amount`.
- **New Rust crate** `softseco-confidential-transfers`, mirroring the five core helpers, published
  to crates.io.
- Rust CI (fmt, clippy, build, test).

## [0.1.0]

### Added
- Initial TypeScript SDK (alpha): `configureAccount`, `deposit`, `applyPendingBalance`,
  `decryptBalance`, and `transfer`, built on `@solana/kit`.
- Deterministic ElGamal/AES key derivation bound to `(owner, mint)`.
- `transfer` using context-state proof accounts (equality, ciphertext-validity, range).
- Local-validator integration tests (gated behind `CT_LOCAL_PROGRAM=1`) and validator-free unit
  tests in CI. Published to npm.

[Unreleased]: https://github.com/softseco/confidential-sdk/compare/v3.3.0...HEAD
[rust-3.0.0]: https://github.com/softseco/confidential-sdk/releases/tag/rust-v3.0.0
[3.3.0]: https://github.com/softseco/confidential-sdk/releases/tag/v3.3.0
[3.2.0]: https://github.com/softseco/confidential-sdk/releases/tag/v3.2.0
[3.1.0]: https://github.com/softseco/confidential-sdk/releases/tag/v3.1.0
[3.0.1]: https://github.com/softseco/confidential-sdk/releases/tag/v3.0.1
[3.0.0]: https://github.com/softseco/confidential-sdk/releases/tag/v3.0.0
[2.1.0]: https://github.com/softseco/confidential-sdk/releases/tag/v2.1.0
[2.0.0]: https://github.com/softseco/confidential-sdk/releases/tag/v2.0.0
[1.0.1]: https://github.com/softseco/confidential-sdk/releases/tag/v1.0.1
[1.0.0]: https://github.com/softseco/confidential-sdk/releases/tag/v1.0.0
[0.2.0]: https://github.com/softseco/confidential-sdk/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/@softseco/confidential-transfers/v/0.1.0
