# Security Policy

This project implements cryptographic, security-sensitive functionality (ElGamal/AES key handling
and zero-knowledge proofs for Token-2022 Confidential Transfers). We take security reports
seriously and appreciate responsible disclosure.

> **Note:** This SDK is validated against a local validator and depends on Solana's ZK ElGamal
> Proof Program being available on the target cluster. Review the maturity notes in the
> [README](./README.md) before relying on it beyond a local validator.

## Supported versions

| Version | Supported |
|---|---|
| `1.x`   | ✅ |
| `< 1.0` | ❌ |

Security fixes land on the latest `1.x` release of both the TypeScript package and the Rust crate.

## Reporting a vulnerability

Please do **not** open a public GitHub issue, pull request, or social post for security reports.

Instead, use one of:

1. **GitHub private vulnerability reporting** (preferred) — on the repository, go to the
   **Security** tab → **Report a vulnerability**. This opens a private advisory with the maintainers.
2. **Email** — contact the maintainer at **hello@softseco.com** with the details.

Please include, where possible:

- A description of the issue and its potential impact
- Steps to reproduce or a proof of concept
- Affected version(s) and environment (cluster, Node/Rust versions)
- Any suggested remediation

## What to expect

- We aim to acknowledge a report within **72 hours**.
- We'll work with you to understand and validate the issue, and keep you updated on remediation.
- Once a fix is released, we're happy to credit you in the advisory unless you prefer to remain
  anonymous.

Thank you for helping keep the ecosystem safe.
