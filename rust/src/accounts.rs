// SPDX-License-Identifier: Apache-2.0
//! Reading mints and token accounts before acting on them, so that a missing account, a missing
//! extension or a full pending balance fails with a clear error before anything is signed.
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use solana_zk_sdk::encryption::{
    auth_encryption::{AeCiphertext, AeKey},
    elgamal::ElGamalPubkey,
};
use solana_zk_sdk_pod::encryption::elgamal::PodElGamalPubkey;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{ConfidentialTransferAccount, ConfidentialTransferMint},
        transfer_hook, BaseStateWithExtensions, StateWithExtensionsOwned,
    },
    state::{Account, Mint},
};

use crate::error::{Error, ErrorCode, Result};
use crate::keys::ConfidentialKeys;

pub(crate) struct MintInfo {
    pub decimals: u8,
    pub auditor: Option<ElGamalPubkey>,
    pub transfer_hook_program: Option<Pubkey>,
}

pub(crate) async fn read_mint(
    rpc: &RpcClient,
    program_id: &Pubkey,
    mint: &Pubkey,
    operation: &'static str,
) -> Result<MintInfo> {
    let account = fetch(rpc, mint, operation).await?.ok_or_else(|| {
        Error::new(
            ErrorCode::AccountNotFound,
            operation,
            format!("mint {mint} does not exist"),
        )
    })?;
    let not_a_mint = || {
        Error::new(
            ErrorCode::InvalidInput,
            operation,
            format!("{mint} is not a Token-2022 mint"),
        )
    };
    if account.owner != *program_id {
        return Err(not_a_mint());
    }
    let state = StateWithExtensionsOwned::<Mint>::unpack(account.data).map_err(|_| not_a_mint())?;
    let auditor = match state.get_extension::<ConfidentialTransferMint>() {
        Ok(ct) => Option::<PodElGamalPubkey>::from(ct.auditor_elgamal_pubkey)
            .map(|pod| {
                ElGamalPubkey::try_from(pod).map_err(|_| {
                    Error::new(ErrorCode::InvalidInput, operation, format!("mint {mint} has a malformed auditor key"))
                })
            })
            .transpose()?,
        Err(_) => {
            return Err(Error::new(
                ErrorCode::InvalidInput,
                operation,
                format!("mint {mint} does not have confidential transfers enabled (no ConfidentialTransferMint extension)"),
            ))
        }
    };
    Ok(MintInfo {
        decimals: state.base.decimals,
        auditor,
        transfer_hook_program: transfer_hook::get_program_id(&state),
    })
}

pub(crate) struct TokenAccount {
    pub state: StateWithExtensionsOwned<Account>,
}

impl TokenAccount {
    pub fn confidential(&self) -> Option<ConfidentialTransferAccount> {
        self.state
            .get_extension::<ConfidentialTransferAccount>()
            .ok()
            .copied()
    }
}

/// A token account, or None if it does not exist.
pub(crate) async fn read_token_account(
    rpc: &RpcClient,
    address: &Pubkey,
    mint: &Pubkey,
    operation: &'static str,
) -> Result<Option<TokenAccount>> {
    let Some(account) = fetch(rpc, address, operation).await? else {
        return Ok(None);
    };
    let state = StateWithExtensionsOwned::<Account>::unpack(account.data).map_err(|_| {
        Error::new(
            ErrorCode::InvalidInput,
            operation,
            format!("{address} is not a Token-2022 token account"),
        )
    })?;
    if state.base.mint != *mint {
        return Err(Error::new(
            ErrorCode::InvalidInput,
            operation,
            format!(
                "token account {address} belongs to mint {}, not {mint}",
                state.base.mint
            ),
        ));
    }
    Ok(Some(TokenAccount { state }))
}

/// A token account that must exist and be configured for confidential transfers. `whose` goes
/// into the message: "your", "the recipient's".
pub(crate) async fn read_configured_account(
    rpc: &RpcClient,
    address: &Pubkey,
    mint: &Pubkey,
    operation: &'static str,
    whose: &str,
) -> Result<(TokenAccount, ConfidentialTransferAccount)> {
    let account = read_token_account(rpc, address, mint, operation).await?.ok_or_else(|| {
        Error::new(
            ErrorCode::AccountNotFound,
            operation,
            format!("{whose} token account {address} does not exist. It is created by configure_account."),
        )
    })?;
    let ct = account.confidential().ok_or_else(|| {
        Error::new(
            ErrorCode::AccountNotConfigured,
            operation,
            format!(
                "{whose} token account {address} is missing the ConfidentialTransferAccount extension; \
                 it has to be set up with configure_account first."
            ),
        )
    })?;
    Ok((account, ct))
}

/// Fails unless the account can take one more incoming deposit or transfer.
pub(crate) fn assert_can_receive(
    ct: &ConfidentialTransferAccount,
    address: &Pubkey,
    operation: &'static str,
    whose: &str,
) -> Result<()> {
    if !bool::from(ct.approved) {
        return Err(Error::new(
            ErrorCode::AccountNotApproved,
            operation,
            format!(
                "{whose} token account {address} has not been approved for confidential transfers by the mint's \
                 confidential-transfer authority."
            ),
        ));
    }
    if !bool::from(ct.allow_confidential_credits) {
        return Err(Error::new(
            ErrorCode::RecipientRejectsConfidential,
            operation,
            format!("{whose} token account {address} does not accept confidential credits."),
        ));
    }
    let received = u64::from(ct.pending_balance_credit_counter);
    if received >= u64::from(ct.maximum_pending_balance_credit_counter) {
        let next = if whose == "your" {
            "Run apply_pending_balance first."
        } else {
            "The recipient has to run apply_pending_balance first."
        };
        return Err(Error::new(
            ErrorCode::PendingBalanceLimit,
            operation,
            format!(
                "{whose} token account {address} has received {received} deposits or transfers since its pending \
                 balance was last applied, the most it takes. {next}"
            ),
        ));
    }
    Ok(())
}

/// Fails unless `keys` are the keys `ct` is configured with.
pub(crate) fn assert_keys_match(
    keys: &ConfidentialKeys,
    ct: &ConfidentialTransferAccount,
    address: &Pubkey,
    operation: &'static str,
) -> Result<()> {
    if PodElGamalPubkey::from(*keys.elgamal_pubkey()) != ct.elgamal_pubkey {
        return Err(Error::new(
            ErrorCode::KeysMismatch,
            operation,
            format!(
                "token account {address} is configured with another ElGamal key than the one derived from this \
                 signer. It was configured by another wallet, or with keys derived another way."
            ),
        ));
    }
    Ok(())
}

/// The available balance, from the owner's AES copy.
pub(crate) fn available_balance(
    ct: &ConfidentialTransferAccount,
    ae: &AeKey,
    address: &Pubkey,
    operation: &'static str,
) -> Result<u64> {
    let fail = || {
        Error::new(
            ErrorCode::DecryptionFailed,
            operation,
            format!("could not decrypt the available balance of {address}"),
        )
    };
    let ciphertext =
        AeCiphertext::try_from(ct.decryptable_available_balance).map_err(|_| fail())?;
    ae.decrypt(&ciphertext).ok_or_else(fail)
}

async fn fetch(
    rpc: &RpcClient,
    address: &Pubkey,
    operation: &'static str,
) -> Result<Option<solana_sdk::account::Account>> {
    rpc.get_account_with_commitment(address, rpc.commitment())
        .await
        .map(|r| r.value)
        .map_err(|e| {
            Error::new(
                ErrorCode::Rpc,
                operation,
                format!("could not read account {address}: {e}"),
            )
            .with_source(e)
        })
}
