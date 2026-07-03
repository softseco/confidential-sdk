// SPDX-License-Identifier: Apache-2.0
//! Confidential-transfer operations, mirroring the TypeScript SDK. Thin async
//! wrappers over `spl_token_client::token::Token`.
use std::sync::Arc;

use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::{pubkey::Pubkey, signature::Signature, signer::Signer};
use spl_token_2022::extension::ExtensionType;
use spl_token_client::{
    client::{ProgramRpcClient, ProgramRpcClientSendTransaction, RpcClientResponse},
    token::Token,
};

use crate::keys::derive_account_keys;

/// Build a Token-2022 client bound to a mint, using a non-blocking RPC client.
fn confidential_token(
    rpc_url: &str,
    mint: &Pubkey,
    decimals: u8,
    payer: Arc<dyn Signer>,
) -> Token<ProgramRpcClientSendTransaction> {
    let rpc = Arc::new(RpcClient::new(rpc_url.to_string()));
    let client = Arc::new(ProgramRpcClient::new(rpc, ProgramRpcClientSendTransaction));
    Token::new(client, &spl_token_2022::id(), mint, Some(decimals), payer)
}

/// Configure the owner's associated token account for confidential transfers:
/// create the ATA, reallocate it for the confidential-transfer extension, and
/// configure it (the ZK pubkey-validity proof is generated inline).
pub async fn configure_account(
    rpc_url: &str,
    payer: Arc<dyn Signer>,
    owner: &dyn Signer,
    mint: &Pubkey,
    decimals: u8,
) -> Result<Signature, Box<dyn std::error::Error>> {
    let token = confidential_token(rpc_url, mint, decimals, payer);
    let account = token.get_associated_token_address(&owner.pubkey());

    // Create the ATA (ignore if it already exists), then add the CT extension.
    let _ = token.create_associated_token_account(&owner.pubkey()).await;
    token
        .reallocate(
            &account,
            &owner.pubkey(),
            &[ExtensionType::ConfidentialTransferAccount],
            &[owner],
        )
        .await?;

    let (elgamal_keypair, aes_key) = derive_account_keys(owner, &account)?;

    let response = token
        .confidential_transfer_configure_token_account(
            &account,
            &owner.pubkey(),
            None, // context_state_account: None -> proof generated inline
            None, // maximum_pending_balance_credit_counter -> default (65536)
            &elgamal_keypair,
            &aes_key,
            &[owner],
        )
        .await?;
    match response {
        RpcClientResponse::Signature(signature) => Ok(signature),
        _ => Err("configure_account: expected a transaction signature".into()),
    }
}
