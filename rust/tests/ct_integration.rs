// SPDX-License-Identifier: Apache-2.0
//! End-to-end integration test for the confidential-transfer flow.
//!
//! Gated behind `CT_LOCAL_PROGRAM=1`: it requires a local validator running the
//! ZK ElGamal Proof Program plus a client-matching Token-2022 build (the same
//! setup the TypeScript SDK's on-chain tests use). Run with:
//!
//!   CT_LOCAL_PROGRAM=1 cargo test --test ct_integration -- --nocapture
//!
//! Without the env var the test is skipped, so `cargo test` stays green in CI.
use std::sync::Arc;

use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::{pubkey::Pubkey, signature::Keypair, signer::Signer};
use spl_token_client::{
    client::{ProgramRpcClient, ProgramRpcClientSendTransaction},
    token::{ExtensionInitializationParams, Token},
};

use softseco_confidential_transfers::{
    apply_pending_balance, configure_account, decrypt_balance, deposit, transfer,
};

const RPC_URL: &str = "http://127.0.0.1:8899";
const DECIMALS: u8 = 2;

#[tokio::test]
async fn confidential_transfer_end_to_end() {
    if std::env::var("CT_LOCAL_PROGRAM").is_err() {
        eprintln!("skipping: set CT_LOCAL_PROGRAM=1 and run a local validator with the ZK program");
        return;
    }
    run().await.expect("confidential transfer flow failed");
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let rpc = Arc::new(RpcClient::new(RPC_URL.to_string()));

    // Only the fee payer needs SOL; owners sign but the payer covers fees + rent.
    let payer: Arc<dyn Signer> = Arc::new(Keypair::new());
    airdrop(&rpc, &payer.pubkey(), 2_000_000_000).await?;
    eprintln!(
        "[setup] payer balance = {}",
        rpc.get_balance(&payer.pubkey()).await?
    );

    let mint = Keypair::new();
    let mint_authority = Keypair::new();
    let alice = Keypair::new();
    let bob = Keypair::new();

    // 1. Create a Token-2022 mint with the ConfidentialTransfer extension.
    eprintln!("[1] create mint");
    let token = Token::new(
        Arc::new(ProgramRpcClient::new(
            rpc.clone(),
            ProgramRpcClientSendTransaction,
        )),
        &spl_token_2022::id(),
        &mint.pubkey(),
        Some(DECIMALS),
        payer.clone(),
    );
    token
        .create_mint(
            &mint_authority.pubkey(),
            None,
            vec![ExtensionInitializationParams::ConfidentialTransferMint {
                authority: Some(mint_authority.pubkey()),
                auto_approve_new_accounts: true,
                auditor_elgamal_pubkey: None,
            }],
            &[&mint],
        )
        .await?;

    // 2. Configure Alice and Bob for confidential transfers.
    eprintln!("[2a] configure alice");
    configure_account(RPC_URL, payer.clone(), &alice, &mint.pubkey(), DECIMALS).await?;
    eprintln!("[2b] configure bob");
    configure_account(RPC_URL, payer.clone(), &bob, &mint.pubkey(), DECIMALS).await?;

    // 3. Mint public tokens to Alice, move them into the confidential balance.
    let alice_ata = token.get_associated_token_address(&alice.pubkey());
    eprintln!("[3a] mint_to alice");
    token
        .mint_to(
            &alice_ata,
            &mint_authority.pubkey(),
            1000,
            &[&mint_authority],
        )
        .await?;
    eprintln!("[3b] deposit");
    deposit(
        RPC_URL,
        payer.clone(),
        &alice,
        &mint.pubkey(),
        1000,
        DECIMALS,
    )
    .await?;
    eprintln!("[3c] apply alice");
    apply_pending_balance(RPC_URL, payer.clone(), &alice, &mint.pubkey(), DECIMALS).await?;

    // 4. Confidentially transfer 400 from Alice to Bob.  <-- the path under test (R1).
    eprintln!("[4] TRANSFER (the path under test)");
    transfer(
        RPC_URL,
        payer.clone(),
        &alice,
        &mint.pubkey(),
        &bob.pubkey(),
        400,
        DECIMALS,
        None,
    )
    .await?;

    // 5. Bob rolls in his pending balance and decrypts it.
    eprintln!("[5] apply bob + decrypt");
    apply_pending_balance(RPC_URL, payer.clone(), &bob, &mint.pubkey(), DECIMALS).await?;
    let bob_balance =
        decrypt_balance(RPC_URL, payer.clone(), &bob, &mint.pubkey(), DECIMALS).await?;
    assert_eq!(bob_balance, 400, "Bob should have received 400");

    // 6. Alice keeps the remaining 600.
    let alice_balance =
        decrypt_balance(RPC_URL, payer.clone(), &alice, &mint.pubkey(), DECIMALS).await?;
    assert_eq!(alice_balance, 600, "Alice should have 600 left");

    println!("OK — Alice: {alice_balance}, Bob: {bob_balance}");
    Ok(())
}

async fn airdrop(
    rpc: &RpcClient,
    pubkey: &Pubkey,
    lamports: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    // Local faucets occasionally rate-limit back-to-back requests; retry a few times.
    let mut last_err: Option<Box<dyn std::error::Error>> = None;
    for _ in 0..8 {
        match rpc.request_airdrop(pubkey, lamports).await {
            Ok(_signature) => {
                // Wait until the balance is actually visible before returning.
                for _ in 0..40 {
                    if rpc.get_balance(pubkey).await.unwrap_or(0) >= lamports {
                        return Ok(());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
                // Airdrop was accepted but never credited — a stalled validator.
                // Fall through and retry rather than silently returning success.
                last_err =
                    Some("airdrop accepted but balance never credited (validator stalled?)".into());
            }
            Err(e) => {
                last_err = Some(Box::new(e));
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "airdrop failed after retries".into()))
}
