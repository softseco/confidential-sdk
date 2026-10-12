// SPDX-License-Identifier: Apache-2.0
//! Token-2022 confidential transfers in Rust: a mirror of the
//! [`@softseco/confidential-transfers`](https://www.npmjs.com/package/@softseco/confidential-transfers)
//! TypeScript SDK, with the same keys, the same checks and the same error codes.
//!
//! [`ConfidentialClient`] configures accounts, deposits, applies pending balances, reads
//! balances, transfers and withdraws. A transfer verifies its proofs into temporary proof
//! accounts, reads the mint's auditor key and transfer hook, and cleans up after itself when a
//! step fails.
//!
//! For token accounts owned by a program, [`ConfidentialClient::prepare_transfer`] and its
//! siblings generate and verify the proofs, and return what the program needs to make the
//! transfer through a cross-program call; `examples/anchor-vault` is a complete Anchor program.
//!
//! Keys come from the owner's wallet with the standard derivation ([`ConfidentialKeys`]), so an
//! account configured here can be used with the TypeScript SDK, the spl-token CLI and any other
//! standard client.

mod accounts;
pub mod auditor;
mod client;
pub mod compat;
pub mod error;
pub mod keys;
mod proofs;
mod send;

pub use auditor::{decrypt_auditor_amount, derive_auditor_keypair};
pub use client::{
    ConfidentialClient, ConfigureAccountResult, PendingBalanceUpdate, PreparedConfigure,
    PreparedTransfer, PreparedWithdraw, RecoverProofAccountsResult, TransferResult, WithdrawResult,
    TOKEN_2022_PROGRAM_ID,
};
#[allow(deprecated)]
pub use compat::{apply_pending_balance, configure_account, decrypt_balance, deposit, transfer};
pub use error::{Error, ErrorCode, ProofAccounts, Result};
pub use keys::{derive_account_keys, pda_wallet_public_seed, ConfidentialKeys};

/// The crate version, from `Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
