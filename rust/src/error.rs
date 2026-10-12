// SPDX-License-Identifier: Apache-2.0
//! Errors, with the same codes as the TypeScript SDK's `ConfidentialTransfersError`.
//!
//! Every fallible function in this crate returns [`Error`]. Match on [`Error::code`] to react to
//! a specific failure; the message says what went wrong in words, naming the account involved.
use std::fmt;

use solana_sdk::{pubkey::Pubkey, signature::Signature};

/// What went wrong. [`ErrorCode::as_str`] gives the TypeScript SDK's code for the same failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ErrorCode {
    /// An argument is invalid (zero amount, an account of another mint).
    InvalidInput,
    /// A token account or mint the call needs does not exist.
    AccountNotFound,
    /// The token account has no confidential-transfer extension; run `configure_account` first.
    AccountNotConfigured,
    /// `configure_account` on an account that is already configured.
    AccountAlreadyConfigured,
    /// The account is configured but not approved by the mint's confidential-transfer authority.
    AccountNotApproved,
    /// The recipient's account does not accept confidential transfers.
    RecipientRejectsConfidential,
    /// The account has taken as many incoming deposits and transfers as it allows before its
    /// pending balance is applied. Its owner has to run `apply_pending_balance` first.
    PendingBalanceLimit,
    /// More than the available (or, for a deposit, the public) balance.
    InsufficientFunds,
    /// Above what one deposit or transfer can carry: 2^48 - 1 base units.
    AmountTooLarge,
    /// The keys are not the keys the account is configured with.
    KeysMismatch,
    /// A balance could not be decrypted.
    DecryptionFailed,
    /// The signer could not sign the key-derivation message.
    CannotSignMessages,
    /// The signer returned a signature that cannot be used to derive keys.
    BadMessageSignature,
    /// A transaction failed in simulation or on chain; [`Error::logs`] has the program logs.
    TransactionFailed,
    /// A transaction was not confirmed before its blockhash expired. Safe to retry.
    TransactionExpired,
    /// The RPC request itself failed (network, rate limit, node error). Rust only.
    Rpc,
}

impl ErrorCode {
    /// The code as the TypeScript SDK spells it, e.g. `"PENDING_BALANCE_LIMIT"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "INVALID_INPUT",
            Self::AccountNotFound => "ACCOUNT_NOT_FOUND",
            Self::AccountNotConfigured => "ACCOUNT_NOT_CONFIGURED",
            Self::AccountAlreadyConfigured => "ACCOUNT_ALREADY_CONFIGURED",
            Self::AccountNotApproved => "ACCOUNT_NOT_APPROVED",
            Self::RecipientRejectsConfidential => "RECIPIENT_REJECTS_CONFIDENTIAL",
            Self::PendingBalanceLimit => "PENDING_BALANCE_LIMIT",
            Self::InsufficientFunds => "INSUFFICIENT_FUNDS",
            Self::AmountTooLarge => "AMOUNT_TOO_LARGE",
            Self::KeysMismatch => "KEYS_MISMATCH",
            Self::DecryptionFailed => "DECRYPTION_FAILED",
            Self::CannotSignMessages => "CANNOT_SIGN_MESSAGES",
            Self::BadMessageSignature => "BAD_MESSAGE_SIGNATURE",
            Self::TransactionFailed => "TRANSACTION_FAILED",
            Self::TransactionExpired => "TRANSACTION_EXPIRED",
            Self::Rpc => "RPC_ERROR",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Proof accounts of a transfer or withdraw that failed partway.
///
/// The crate closes the proof accounts it created when a step fails, and their rent goes back to
/// the payer. Any it could not close are in `left_open`; [`crate::ConfidentialClient::recover_proof_accounts`]
/// closes them later.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProofAccounts {
    pub closed: Vec<Pubkey>,
    pub left_open: Vec<Pubkey>,
}

type Source = Box<dyn std::error::Error + Send + Sync + 'static>;

/// The crate's error: a [`ErrorCode`], a message, and what is known about the failure.
#[derive(Debug)]
pub struct Error(Box<Inner>);

#[derive(Debug)]
struct Inner {
    code: ErrorCode,
    message: String,
    operation: &'static str,
    step: Option<&'static str>,
    logs: Vec<String>,
    signatures: Vec<Signature>,
    proof_accounts: Option<ProofAccounts>,
    retryable: bool,
    source: Option<Source>,
}

/// `Result` with this crate's [`Error`].
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub(crate) fn new(
        code: ErrorCode,
        operation: &'static str,
        message: impl Into<String>,
    ) -> Self {
        Self(Box::new(Inner {
            code,
            message: format!("{operation}: {}", message.into()),
            operation,
            step: None,
            logs: Vec::new(),
            signatures: Vec::new(),
            proof_accounts: None,
            retryable: code == ErrorCode::TransactionExpired,
            source: None,
        }))
    }

    pub(crate) fn with_step(mut self, step: &'static str) -> Self {
        self.0.step = Some(step);
        self
    }

    pub(crate) fn with_logs(mut self, logs: Vec<String>) -> Self {
        self.0.logs = logs;
        self
    }

    pub(crate) fn with_signatures(mut self, signatures: Vec<Signature>) -> Self {
        self.0.signatures = signatures;
        self
    }

    pub(crate) fn with_proof_accounts(mut self, proof_accounts: ProofAccounts) -> Self {
        self.0.proof_accounts = Some(proof_accounts);
        self
    }

    pub(crate) fn with_source(mut self, source: impl Into<Source>) -> Self {
        self.0.source = Some(source.into());
        self
    }

    /// The same error, reported as part of another operation (its message keeps the details).
    pub(crate) fn within(self, operation: &'static str) -> Self {
        let mut inner = self.0;
        let detail = inner
            .message
            .split_once(": ")
            .map_or(inner.message.clone(), |(_, rest)| rest.to_string());
        inner.message = format!("{operation}: {detail}");
        inner.operation = operation;
        Self(inner)
    }

    /// What went wrong.
    pub fn code(&self) -> ErrorCode {
        self.0.code
    }

    /// The crate function that failed, e.g. `"transfer"`.
    pub fn operation(&self) -> &'static str {
        self.0.operation
    }

    /// For a transfer or withdraw: `"proofs"` (setting up the proof accounts) or the main step.
    pub fn step(&self) -> Option<&'static str> {
        self.0.step
    }

    /// Program logs of the failed transaction, when there are any.
    pub fn logs(&self) -> &[String] {
        &self.0.logs
    }

    /// Transactions of this call that did land before the failure.
    pub fn signatures(&self) -> &[Signature] {
        &self.0.signatures
    }

    /// For a transfer or withdraw that failed partway: the proof accounts closed and left open.
    pub fn proof_accounts(&self) -> Option<&ProofAccounts> {
        self.0.proof_accounts.as_ref()
    }

    /// True when running the same call again can succeed as is (an expired blockhash).
    pub fn is_retryable(&self) -> bool {
        self.0.retryable
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.message)?;
        if let Some(last) = self
            .0
            .logs
            .iter()
            .rev()
            .find(|l| l.contains("failed") || l.contains("Error"))
        {
            write!(f, " (last log: {last})")?;
        }
        Ok(())
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0
            .source
            .as_deref()
            .map(|e| e as &(dyn std::error::Error + 'static))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spells_codes_like_the_typescript_sdk() {
        assert_eq!(
            ErrorCode::PendingBalanceLimit.as_str(),
            "PENDING_BALANCE_LIMIT"
        );
        assert_eq!(
            ErrorCode::RecipientRejectsConfidential.to_string(),
            "RECIPIENT_REJECTS_CONFIDENTIAL"
        );
    }

    #[test]
    fn names_the_operation_and_marks_expiry_as_retryable() {
        let e = Error::new(
            ErrorCode::TransactionExpired,
            "transfer",
            "blockhash expired",
        );
        assert_eq!(e.to_string(), "transfer: blockhash expired");
        assert!(e.is_retryable());
        assert!(!Error::new(ErrorCode::TransactionFailed, "deposit", "x").is_retryable());
    }
}
