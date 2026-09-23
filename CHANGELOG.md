# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions apply to both the TypeScript package
([`@softseco/confidential-transfers`](https://www.npmjs.com/package/@softseco/confidential-transfers))
and the Rust crate
([`softseco-confidential-transfers`](https://crates.io/crates/softseco-confidential-transfers)),
which are released together.

## [2.1.0]

### Added

- `transfer()` now resolves a mint's transfer-hook accounts and appends them to the confidential
  transfer instruction. Token-2022 invokes the hook on a confidential transfer with an amount of
  `u64::MAX`, and without those accounts the transfer fails with `MissingAccount`. Mints without a
  transfer hook are unaffected.
- `resolveTransferHookAccounts`, `getTransferHookProgram` and `findExtraAccountMetaListPda` are
  exported for callers that build their own instructions.

### Notes

- The Rust crate is unchanged at 2.0.0.

## [Unreleased]

_Nothing yet._

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
Keys derived by 1.x and 2.0 are different. Before upgrading, apply the pending balance and
withdraw the confidential balance of any account configured with 1.x; then re-configure it with
2.0. There is no in-place migration, because the on-chain account stores the ElGamal public key
that the old derivation produced.

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

[2.0.0]: https://github.com/softseco/confidential-sdk/releases/tag/v2.0.0
[1.0.1]: https://github.com/softseco/confidential-sdk/releases/tag/v1.0.1
[1.0.0]: https://github.com/softseco/confidential-sdk/releases/tag/v1.0.0
[0.2.0]: https://github.com/softseco/confidential-sdk/releases/tag/v0.2.0
[0.1.0]: https://github.com/softseco/confidential-sdk/releases/tag/v0.1.0
