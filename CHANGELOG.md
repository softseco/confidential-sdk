# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions apply to both the TypeScript package
([`@softseco/confidential-transfers`](https://www.npmjs.com/package/@softseco/confidential-transfers))
and the Rust crate
([`softseco-confidential-transfers`](https://crates.io/crates/softseco-confidential-transfers)),
which are released together.

## [Unreleased]

_Nothing yet._

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

[1.0.1]: https://github.com/softseco/confidential-sdk/releases/tag/v1.0.1
[1.0.0]: https://github.com/softseco/confidential-sdk/releases/tag/v1.0.0
[0.2.0]: https://github.com/softseco/confidential-sdk/releases/tag/v0.2.0
[0.1.0]: https://github.com/softseco/confidential-sdk/releases/tag/v0.1.0
