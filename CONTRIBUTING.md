# Contributing

Thanks for your interest in improving the Confidential Transfers SDK. This repository holds two
packages that are released together:

- **TypeScript** (repository root) — `@softseco/confidential-transfers`
- **Rust** (`rust/`) — `softseco-confidential-transfers`

## Prerequisites

- **Node ≥ 20** and npm (for the TypeScript package)
- **Rust** (stable) with `rustfmt` and `clippy` (for the crate)
- For on-chain tests: the Solana CLI/`solana-test-validator`, a client-matching Token-2022 build,
  and the ZK ElGamal Proof Program (see [Local development](#on-chain-tests))

## TypeScript

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsup + type declarations
npm test              # validator-free unit tests (what CI runs)
npm run coverage      # unit tests with coverage
```

### On-chain tests

The confidential-transfer instructions need a local validator running the ZK ElGamal Proof Program
plus a Token-2022 build that matches the `@solana-program/token-2022` client:

```bash
# 1. build a matching Token-2022 program
cargo build-sbf --manifest-path <token-2022-source>/program/Cargo.toml

# 2. start the validator with that program (leave running)
TOKEN_2022_SO=$(find <token-2022-source> -name 'spl_token_2022.so' -path '*deploy*' | head -1) \
  npm run validator

# 3. run the integration tests against it
CT_LOCAL_PROGRAM=1 npm test
```

Without `CT_LOCAL_PROGRAM=1`, on-chain tests are skipped and only unit tests run.

## Rust

```bash
cd rust
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo build
cargo test          # unit tests
```

Dependencies are pinned with `=` to the exact set the official `spl-token-cli` uses, because the
Solana crate ecosystem is mid-migration (3.x → 4.x) and newer patches pull conflicting majors.
Keep `Cargo.lock` committed and in sync when changing dependencies.

## Pull requests

- Open an issue first for anything larger than a small fix, so we can align on the approach.
- Keep the two packages in parity: a change to a helper's behavior should land in both TS and Rust,
  or explain why not.
- Before pushing: unit tests pass, `tsc` is clean, and (for Rust) `fmt`/`clippy` are clean. CI runs
  all of these.
- Update [CHANGELOG.md](./CHANGELOG.md) under an `Unreleased` heading, and the docs if you change
  the public API.
- Keep commits focused and messages descriptive.

## Reporting security issues

Please do **not** open a public issue for vulnerabilities. See [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the project's Apache-2.0
license.
