// SPDX-License-Identifier: Apache-2.0
//! Rust helpers for SPL Token-2022 Confidential Transfers — a mirror of the
//! [`@softseco/confidential-transfers`](https://www.npmjs.com/package/@softseco/confidential-transfers)
//! TypeScript SDK.
//!
//! Built on [`spl-token-client`] and [`solana-zk-sdk`]. Provides the
//! confidential-transfer operations (`configure_account`, `deposit`, `transfer`,
//! `apply_pending_balance`, `decrypt_balance`) and auditor-key
//! selective-disclosure utilities (`derive_auditor_keypair`,
//! `decrypt_auditor_amount`).

pub mod auditor;
pub mod keys;
pub mod operations;

pub use auditor::{decrypt_auditor_amount, derive_auditor_keypair};
pub use keys::derive_account_keys;
pub use operations::{
    apply_pending_balance, configure_account, decrypt_balance, deposit, transfer,
};

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
