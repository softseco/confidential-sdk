// SPDX-License-Identifier: Apache-2.0
//! The 2.x free functions, kept for one major version as thin wrappers over
//! [`crate::ConfidentialClient`]. Each builds its own RPC client with `confirmed` commitment.
#![allow(deprecated)]
use std::sync::Arc;

use solana_client::{nonblocking::rpc_client::RpcClient, rpc_config::CommitmentConfig};
use solana_sdk::{pubkey::Pubkey, signature::Signature, signer::Signer};
use solana_zk_sdk::encryption::elgamal::ElGamalPubkey;

use crate::{ConfidentialClient, Result};

fn client(rpc_url: &str, payer: Arc<dyn Signer>) -> ConfidentialClient {
    ConfidentialClient::new(
        Arc::new(RpcClient::new_with_commitment(
            rpc_url.to_string(),
            CommitmentConfig::confirmed(),
        )),
        payer,
    )
}

#[deprecated(since = "3.0.0", note = "use ConfidentialClient::configure_account")]
pub async fn configure_account(
    rpc_url: &str,
    payer: Arc<dyn Signer>,
    owner: &dyn Signer,
    mint: &Pubkey,
    _decimals: u8,
) -> Result<Signature> {
    Ok(client(rpc_url, payer)
        .configure_account(owner, mint)
        .await?
        .signature)
}

#[deprecated(since = "3.0.0", note = "use ConfidentialClient::deposit")]
pub async fn deposit(
    rpc_url: &str,
    payer: Arc<dyn Signer>,
    owner: &dyn Signer,
    mint: &Pubkey,
    amount: u64,
    _decimals: u8,
) -> Result<Signature> {
    client(rpc_url, payer).deposit(owner, mint, amount).await
}

#[deprecated(
    since = "3.0.0",
    note = "use ConfidentialClient::apply_pending_balance"
)]
pub async fn apply_pending_balance(
    rpc_url: &str,
    payer: Arc<dyn Signer>,
    owner: &dyn Signer,
    mint: &Pubkey,
    _decimals: u8,
) -> Result<Signature> {
    client(rpc_url, payer)
        .apply_pending_balance(owner, mint)
        .await
}

#[deprecated(since = "3.0.0", note = "use ConfidentialClient::decrypt_balance")]
pub async fn decrypt_balance(
    rpc_url: &str,
    payer: Arc<dyn Signer>,
    owner: &dyn Signer,
    mint: &Pubkey,
    _decimals: u8,
) -> Result<u64> {
    client(rpc_url, payer).decrypt_balance(owner, mint).await
}

/// The auditor key is now read from the mint; `auditor_elgamal_pubkey` is ignored.
#[deprecated(
    since = "3.0.0",
    note = "use ConfidentialClient::transfer, which reads the auditor key from the mint"
)]
#[allow(clippy::too_many_arguments)]
pub async fn transfer(
    rpc_url: &str,
    payer: Arc<dyn Signer>,
    owner: &dyn Signer,
    mint: &Pubkey,
    destination_owner: &Pubkey,
    amount: u64,
    _decimals: u8,
    _auditor_elgamal_pubkey: Option<&ElGamalPubkey>,
) -> Result<Signature> {
    Ok(client(rpc_url, payer)
        .transfer(owner, mint, destination_owner, amount)
        .await?
        .transfer_signature)
}
