// SPDX-License-Identifier: Apache-2.0
//! Rust helpers for SPL Token-2022 Confidential Transfers — a mirror of the
//! [`@softseco/confidential-transfers`](https://www.npmjs.com/package/@softseco/confidential-transfers)
//! TypeScript SDK.
//!
//! Built on [`spl-token-client`] and [`solana-zk-sdk`]. The confidential-transfer
//! helpers (`configure_account`, `deposit`, `transfer`, `apply_pending_balance`,
//! `decrypt_balance`) and the auditor-key selective-disclosure utilities are added
//! incrementally on top of this foundation.

/// The crate version, from `Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_a_version() {
        assert!(!VERSION.is_empty());
    }
}
