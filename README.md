# Confidential Transfers SDK

Open-source TypeScript + Rust SDK for **Token-2022 Confidential Transfers** on Solana.
It packages ElGamal key handling, proof-context accounts, and the confidential-transfer
instructions into clean function calls, so any Solana developer can integrate confidential
balances and transfers without hand-assembling the primitives.

> **Status: in active development (Foundation Phase). Not production-ready.**
> Token-2022 confidential transfers depend on Solana's ZK ElGamal Proof Program, which was
> disabled on mainnet/devnet in June 2025 and is expected to re-enable in the Agave 4.x cycle
> during 2026. This SDK is developed and tested against a local validator with the proof
> program enabled (see `scripts/start-test-validator.sh`).

## Planned API (TypeScript)

| Function | Purpose |
|---|---|
| `configureAccount()` | Configure a Token-2022 account for confidential transfers |
| `deposit()` | Move tokens from the public balance to the confidential pending balance |
| `transfer()` | Send an encrypted amount |
| `applyPendingBalance()` | Accept received confidential balance |
| `decryptBalance()` | Decrypt your own balance with an ElGamal viewing key |

A Rust crate mirroring the TypeScript helpers, plus Auditor-Key selective-disclosure
utilities, are planned (see project milestones).

## Requirements

- Node.js >= 18
- Rust (stable), Solana CLI / Agave, Anchor (for the local validator)
- A local validator with the ZK ElGamal Proof Program enabled

## Quick start

```bash
npm install
# Terminal 1 — start a CT-capable local validator (leave running):
npm run validator
# Terminal 2 — run the test suite:
npm test
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
