// SPDX-License-Identifier: Apache-2.0
//! Confidential-transfer operations, mirroring the TypeScript SDK. Thin async
//! wrappers over `spl_token_client::token::Token`.
use std::sync::Arc;

use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signature},
    signer::Signer,
};
use solana_zk_sdk::encryption::{auth_encryption::AeCiphertext, elgamal::ElGamalPubkey};
use spl_token_2022::extension::{
    confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensions, ExtensionType,
};
use spl_token_client::{
    client::{ProgramRpcClient, ProgramRpcClientSendTransaction, RpcClientResponse},
    token::{ComputeUnitLimit, ProofAccountWithCiphertext, Token},
    zk_proofs::confidential_transfer::TransferAccountInfo,
};
use spl_token_confidential_transfer_proof_generation::transfer::TransferProofData;

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

/// Move public tokens into the account's confidential pending balance. The
/// account must already be configured for confidential transfers.
pub async fn deposit(
    rpc_url: &str,
    payer: Arc<dyn Signer>,
    owner: &dyn Signer,
    mint: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Result<Signature, Box<dyn std::error::Error>> {
    let token = confidential_token(rpc_url, mint, decimals, payer);
    let account = token.get_associated_token_address(&owner.pubkey());
    let response = token
        .confidential_transfer_deposit(&account, &owner.pubkey(), amount, decimals, &[owner])
        .await?;
    match response {
        RpcClientResponse::Signature(signature) => Ok(signature),
        _ => Err("deposit: expected a transaction signature".into()),
    }
}

/// Roll the account's confidential pending balance into its available balance.
/// The keys are derived from the owner's signer.
pub async fn apply_pending_balance(
    rpc_url: &str,
    payer: Arc<dyn Signer>,
    owner: &dyn Signer,
    mint: &Pubkey,
    decimals: u8,
) -> Result<Signature, Box<dyn std::error::Error>> {
    let token = confidential_token(rpc_url, mint, decimals, payer);
    let account = token.get_associated_token_address(&owner.pubkey());
    let (elgamal_keypair, aes_key) = derive_account_keys(owner, &account)?;
    let response = token
        .confidential_transfer_apply_pending_balance(
            &account,
            &owner.pubkey(),
            None, // fetch the account state internally
            elgamal_keypair.secret(),
            &aes_key,
            &[owner],
        )
        .await?;
    match response {
        RpcClientResponse::Signature(signature) => Ok(signature),
        _ => Err("apply_pending_balance: expected a transaction signature".into()),
    }
}

/// Decrypt the account's confidential available balance (read-only). The AES key
/// is derived from the owner's signer.
pub async fn decrypt_balance(
    rpc_url: &str,
    payer: Arc<dyn Signer>,
    owner: &dyn Signer,
    mint: &Pubkey,
    decimals: u8,
) -> Result<u64, Box<dyn std::error::Error>> {
    let token = confidential_token(rpc_url, mint, decimals, payer);
    let account = token.get_associated_token_address(&owner.pubkey());
    let (_elgamal_keypair, aes_key) = derive_account_keys(owner, &account)?;

    let account_info = token.get_account_info(&account).await?;
    let ct_account = account_info.get_extension::<ConfidentialTransferAccount>()?;
    let ciphertext: AeCiphertext = ct_account.decryptable_available_balance.try_into()?;
    aes_key
        .decrypt(&ciphertext)
        .ok_or_else(|| "decrypt_balance: failed to decrypt the available balance".into())
}

/// Confidentially transfer tokens from the owner's available balance to another
/// account. Keys are derived from the owner's signer; pass `auditor_elgamal_pubkey`
/// for auditor-enabled mints.
///
/// The three required ZK proofs (equality, ciphertext validity, range) are too large
/// to ship inline — that made the transaction ~3308 bytes, over Solana's 1232-byte
/// limit. Instead, each proof is verified into a temporary **context-state account**
/// up front; the transfer instruction then only references those three accounts, and
/// they are closed afterwards to reclaim rent (their lamports go back to the payer).
/// Same flow as the TypeScript SDK and the official `spl-token` CLI.
#[allow(clippy::too_many_arguments)]
pub async fn transfer(
    rpc_url: &str,
    payer: Arc<dyn Signer>,
    owner: &dyn Signer,
    mint: &Pubkey,
    destination_owner: &Pubkey,
    amount: u64,
    decimals: u8,
    auditor_elgamal_pubkey: Option<&ElGamalPubkey>,
) -> Result<Signature, Box<dyn std::error::Error>> {
    let payer_pubkey = payer.pubkey();
    // The range-proof verification consumes exactly the 200k-CU default budget;
    // size compute budgets from simulation, as the official spl-token CLI does.
    let token = confidential_token(rpc_url, mint, decimals, payer.clone())
        .with_compute_unit_limit(ComputeUnitLimit::Simulated);
    let source_account = token.get_associated_token_address(&owner.pubkey());
    let destination_account = token.get_associated_token_address(destination_owner);

    let (source_elgamal_keypair, source_aes_key) = derive_account_keys(owner, &source_account)?;

    // Read the destination's ElGamal public key from its confidential account.
    let destination_info = token.get_account_info(&destination_account).await?;
    let destination_ct = destination_info.get_extension::<ConfidentialTransferAccount>()?;
    let destination_elgamal_pubkey: ElGamalPubkey = destination_ct.elgamal_pubkey.try_into()?;

    // Snapshot the source state once and use it for both proof generation and the
    // transfer instruction, so the proofs and the new balance cannot diverge.
    let source_info = token.get_account_info(&source_account).await?;
    let source_ct = source_info.get_extension::<ConfidentialTransferAccount>()?;
    let transfer_account_info = TransferAccountInfo::new(source_ct);

    let TransferProofData {
        equality_proof_data,
        ciphertext_validity_proof_data_with_ciphertext,
        range_proof_data,
    } = transfer_account_info.generate_split_transfer_proof_data(
        amount,
        &source_elgamal_keypair,
        &source_aes_key,
        &destination_elgamal_pubkey,
        auditor_elgamal_pubkey,
    )?;

    // Verify each proof into its own throwaway context-state account. The range
    // proof's verify instruction is itself near the transaction size limit, so its
    // account creation and proof verification are split into two transactions.
    let equality_keypair = Keypair::new();
    let validity_keypair = Keypair::new();
    let range_keypair = Keypair::new();
    let equality_pubkey = equality_keypair.pubkey();
    let validity_pubkey = validity_keypair.pubkey();
    let range_pubkey = range_keypair.pubkey();
    token
        .confidential_transfer_create_context_state_account(
            &range_pubkey,
            &payer_pubkey,
            &range_proof_data,
            true, // split creation and verification across two transactions
            &[&range_keypair],
        )
        .await?;
    token
        .confidential_transfer_create_context_state_account(
            &equality_pubkey,
            &payer_pubkey,
            &equality_proof_data,
            false,
            &[&equality_keypair],
        )
        .await?;
    token
        .confidential_transfer_create_context_state_account(
            &validity_pubkey,
            &payer_pubkey,
            &ciphertext_validity_proof_data_with_ciphertext.proof_data,
            false,
            &[&validity_keypair],
        )
        .await?;

    let validity_proof_account = ProofAccountWithCiphertext {
        context_state_account: validity_pubkey,
        ciphertext_lo: ciphertext_validity_proof_data_with_ciphertext.ciphertext_lo,
        ciphertext_hi: ciphertext_validity_proof_data_with_ciphertext.ciphertext_hi,
    };

    // The transfer itself now only references the three proof accounts, so the
    // transaction stays well under the packet-size limit.
    let transfer_result = token
        .confidential_transfer_transfer(
            &source_account,
            &destination_account,
            &owner.pubkey(),
            Some(&equality_pubkey),
            Some(&validity_proof_account),
            Some(&range_pubkey),
            amount,
            Some(transfer_account_info),
            &source_elgamal_keypair,
            &source_aes_key,
            &destination_elgamal_pubkey,
            auditor_elgamal_pubkey,
            &[owner],
        )
        .await;

    // Close the context-state accounts to reclaim rent — even when the transfer
    // failed (best effort; a transfer error takes precedence below).
    let mut close_error = None;
    for context_account in [&equality_pubkey, &validity_pubkey, &range_pubkey] {
        let close_result = token
            .confidential_transfer_close_context_state_account(
                context_account,
                &payer_pubkey,
                &payer_pubkey,
                &[payer.as_ref()],
            )
            .await;
        close_error = close_error.or(close_result.err());
    }

    let response = transfer_result?;
    if let Some(error) = close_error {
        return Err(error.into());
    }
    match response {
        RpcClientResponse::Signature(signature) => Ok(signature),
        _ => Err("transfer: expected a transaction signature".into()),
    }
}
