// SPDX-License-Identifier: Apache-2.0
//! [`ConfidentialClient`]: configure, deposit, apply, read, transfer and withdraw, for accounts
//! owned by a wallet; and the same steps prepared for accounts owned by a program.
use std::sync::Arc;

use solana_client::{
    nonblocking::rpc_client::RpcClient,
    rpc_config::{
        RpcAccountInfoConfig, RpcProgramAccountsConfig, UiAccountEncoding, UiDataSliceConfig,
    },
    rpc_filter::{Memcmp, RpcFilterType},
};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Signature,
    signer::Signer,
};
use solana_zk_elgamal_proof_interface::instruction::ProofInstruction;
use solana_zk_sdk::{
    encryption::elgamal::ElGamalPubkey, zk_elgamal_proof_program::build_pubkey_validity_proof_data,
};
use solana_zk_sdk_pod::encryption::{
    auth_encryption::PodAeCiphertext, elgamal::PodElGamalCiphertext,
};
use spl_associated_token_account_interface::{
    address::get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{
            instruction as ct_instruction, ConfidentialTransferAccount,
            DEFAULT_MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER, MAXIMUM_DEPOSIT_TRANSFER_AMOUNT,
        },
        ExtensionType,
    },
    instruction::reallocate,
};
use spl_token_client::zk_proofs::confidential_transfer::{
    ApplyPendingBalanceAccountInfo, TransferAccountInfo, WithdrawAccountInfo,
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
use spl_token_confidential_transfer_proof_generation::{
    transfer::TransferProofData, withdraw::WithdrawProofData,
};

use crate::accounts::{
    assert_can_receive, assert_keys_match, available_balance, read_configured_account, read_mint,
    read_token_account, MintInfo,
};
use crate::error::{Error, ErrorCode, ProofAccounts, Result};
use crate::keys::ConfidentialKeys;
use crate::proofs::{close_instructions, close_proof_accounts, ProofSetup};
use crate::send::Sender;

/// The Token-2022 program.
pub const TOKEN_2022_PROGRAM_ID: Pubkey = spl_token_2022_interface::ID;

/// Confidential transfers of Token-2022 tokens.
///
/// Holds an RPC client and the payer, who pays every fee and the temporary rent of the proof
/// accounts (it gets the rent back). Owners sign their own operations.
///
/// ```no_run
/// # use std::sync::Arc;
/// # use solana_client::{nonblocking::rpc_client::RpcClient, rpc_config::CommitmentConfig};
/// # use solana_sdk::{pubkey::Pubkey, signature::Keypair, signer::Signer};
/// # use softseco_confidential_transfers::ConfidentialClient;
/// # async fn run(payer: Keypair, alice: Keypair, bob: Pubkey, mint: Pubkey) -> softseco_confidential_transfers::Result<()> {
/// let rpc = Arc::new(RpcClient::new_with_commitment("https://api.devnet.solana.com".into(), CommitmentConfig::confirmed()));
/// let client = ConfidentialClient::new(rpc, Arc::new(payer)).with_compute_unit_price(10_000);
///
/// client.configure_account(&alice, &mint).await?;
/// client.deposit(&alice, &mint, 1_000).await?;
/// client.apply_pending_balance(&alice, &mint).await?;
/// let sent = client.transfer(&alice, &mint, &bob, 400).await?;
/// client.withdraw(&alice, &mint, 100).await?;
/// assert_eq!(client.decrypt_balance(&alice, &mint).await?, 500);
/// # Ok(()) }
/// ```
pub struct ConfidentialClient {
    rpc: Arc<RpcClient>,
    payer: Arc<dyn Signer>,
    compute_unit_price: Option<u64>,
    max_retries: u32,
}

/// The result of [`ConfidentialClient::configure_account`].
#[derive(Clone, Debug)]
pub struct ConfigureAccountResult {
    pub token_account: Pubkey,
    pub signature: Signature,
}

/// The result of [`ConfidentialClient::transfer`].
#[derive(Clone, Debug)]
pub struct TransferResult {
    pub source_token_account: Pubkey,
    pub destination_token_account: Pubkey,
    /// Every transaction, in order: the proofs, the transfer, and any separate cleanup.
    pub signatures: Vec<Signature>,
    /// The transaction with the Token-2022 transfer.
    pub transfer_signature: Signature,
}

/// The result of [`ConfidentialClient::withdraw`].
#[derive(Clone, Debug)]
pub struct WithdrawResult {
    pub token_account: Pubkey,
    pub signatures: Vec<Signature>,
    pub withdraw_signature: Signature,
}

/// The result of [`ConfidentialClient::recover_proof_accounts`].
#[derive(Clone, Debug, Default)]
pub struct RecoverProofAccountsResult {
    pub closed: Vec<Pubkey>,
    /// Found but not closed (the closing transaction failed); run again.
    pub left_open: Vec<Pubkey>,
    /// Rent returned to the payer.
    pub lamports: u64,
}

/// A confidential transfer whose proofs are verified into proof accounts and ready to be used by
/// a Token-2022 transfer instruction, sent directly ([`Self::instruction`]) or through a program
/// that owns the source account. Close the proof accounts afterwards with
/// [`ConfidentialClient::close_proof_accounts`].
#[derive(Clone, Debug)]
pub struct PreparedTransfer {
    pub mint: Pubkey,
    pub source_token_account: Pubkey,
    pub destination_token_account: Pubkey,
    pub equality_proof: Pubkey,
    pub ciphertext_validity_proof: Pubkey,
    pub range_proof: Pubkey,
    /// The source's available balance after the transfer, encrypted with its AES key.
    pub new_decryptable_available_balance: [u8; 36],
    /// The amount encrypted to the mint's auditor (all zero when the mint has no auditor).
    pub auditor_ciphertext_lo: [u8; 64],
    pub auditor_ciphertext_hi: [u8; 64],
    /// The transactions that created the proof accounts.
    pub signatures: Vec<Signature>,
}

impl PreparedTransfer {
    pub fn proof_accounts(&self) -> Vec<Pubkey> {
        vec![
            self.equality_proof,
            self.ciphertext_validity_proof,
            self.range_proof,
        ]
    }

    /// The Token-2022 transfer instruction, signed by `authority` (the source account's owner).
    /// It has no transfer-hook accounts; add them with [`ConfidentialClient::transfer_hook_accounts`].
    pub fn instruction(&self, authority: &Pubkey) -> Result<Instruction> {
        let instructions = ct_instruction::transfer(
            &TOKEN_2022_PROGRAM_ID,
            &self.source_token_account,
            &self.mint,
            &self.destination_token_account,
            &PodAeCiphertext(self.new_decryptable_available_balance),
            &PodElGamalCiphertext(self.auditor_ciphertext_lo),
            &PodElGamalCiphertext(self.auditor_ciphertext_hi),
            authority,
            &[],
            ProofLocation::ContextStateAccount(&self.equality_proof),
            ProofLocation::ContextStateAccount(&self.ciphertext_validity_proof),
            ProofLocation::ContextStateAccount(&self.range_proof),
        )
        .map_err(|e| {
            Error::new(
                ErrorCode::InvalidInput,
                "transfer",
                format!("cannot build the transfer instruction: {e}"),
            )
        })?;
        Ok(instructions
            .into_iter()
            .next()
            .expect("one instruction with proof accounts"))
    }
}

/// A withdraw whose proofs are verified into proof accounts. See [`PreparedTransfer`].
#[derive(Clone, Debug)]
pub struct PreparedWithdraw {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub amount: u64,
    pub decimals: u8,
    pub equality_proof: Pubkey,
    pub range_proof: Pubkey,
    pub new_decryptable_available_balance: [u8; 36],
    pub signatures: Vec<Signature>,
}

impl PreparedWithdraw {
    pub fn proof_accounts(&self) -> Vec<Pubkey> {
        vec![self.equality_proof, self.range_proof]
    }

    /// The Token-2022 withdraw instruction, signed by `authority` (the account's owner).
    pub fn instruction(&self, authority: &Pubkey) -> Result<Instruction> {
        let instructions = ct_instruction::withdraw(
            &TOKEN_2022_PROGRAM_ID,
            &self.token_account,
            &self.mint,
            self.amount,
            self.decimals,
            &PodAeCiphertext(self.new_decryptable_available_balance),
            authority,
            &[],
            ProofLocation::ContextStateAccount(&self.equality_proof),
            ProofLocation::ContextStateAccount(&self.range_proof),
        )
        .map_err(|e| {
            Error::new(
                ErrorCode::InvalidInput,
                "withdraw",
                format!("cannot build the withdraw instruction: {e}"),
            )
        })?;
        Ok(instructions
            .into_iter()
            .next()
            .expect("one instruction with proof accounts"))
    }
}

/// What a program-owned account needs to be configured: the ElGamal public key, verified into a
/// proof account, and the AES encryption of a zero balance.
#[derive(Clone, Debug)]
pub struct PreparedConfigure {
    pub pubkey_validity_proof: Pubkey,
    pub elgamal_pubkey: [u8; 32],
    pub decryptable_zero_balance: [u8; 36],
    pub signatures: Vec<Signature>,
}

/// What `ApplyPendingBalance` needs, computed with the owner's keys.
#[derive(Clone, Copy, Debug)]
pub struct PendingBalanceUpdate {
    pub expected_pending_balance_credit_counter: u64,
    pub new_decryptable_available_balance: [u8; 36],
}

impl ConfidentialClient {
    /// A client over `rpc`, with `payer` paying fees and proof-account rent. Use an RPC client
    /// with `confirmed` commitment unless you have a reason not to.
    pub fn new(rpc: Arc<RpcClient>, payer: Arc<dyn Signer>) -> Self {
        Self {
            rpc,
            payer,
            compute_unit_price: None,
            max_retries: 0,
        }
    }

    /// Priority fee in micro-lamports per compute unit, added to every transaction that has
    /// room for it (the range-proof transactions do not).
    pub fn with_compute_unit_price(mut self, micro_lamports: u64) -> Self {
        self.compute_unit_price = Some(micro_lamports);
        self
    }

    /// How many times to send a transaction again when its blockhash expired before it was
    /// confirmed. Default 0.
    pub fn with_max_retries(mut self, retries: u32) -> Self {
        self.max_retries = retries;
        self
    }

    pub fn rpc(&self) -> &Arc<RpcClient> {
        &self.rpc
    }

    pub fn payer(&self) -> Pubkey {
        self.payer.pubkey()
    }

    /// The owner's associated token account for `mint`: the account every operation uses.
    pub fn token_account(&self, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        get_associated_token_address_with_program_id(owner, mint, &TOKEN_2022_PROGRAM_ID)
    }

    fn sender(&self, operation: &'static str) -> Sender<'_> {
        Sender {
            rpc: &self.rpc,
            payer: self.payer.as_ref(),
            compute_unit_price: self.compute_unit_price,
            max_retries: self.max_retries,
            operation,
        }
    }

    /// Create the owner's token account if needed and configure it for confidential transfers,
    /// with the owner's standard keys. One transaction.
    pub async fn configure_account(
        &self,
        owner: &dyn Signer,
        mint: &Pubkey,
    ) -> Result<ConfigureAccountResult> {
        let operation = "configure_account";
        read_mint(&self.rpc, &TOKEN_2022_PROGRAM_ID, mint, operation).await?;
        let owner_key = owner.pubkey();
        let token = self.token_account(&owner_key, mint);
        let existing = read_token_account(&self.rpc, &token, mint, operation).await?;
        if existing
            .as_ref()
            .is_some_and(|a| a.confidential().is_some())
        {
            return Err(Error::new(
                ErrorCode::AccountAlreadyConfigured,
                operation,
                format!("token account {token} is already configured for confidential transfers"),
            ));
        }
        let keys = ConfidentialKeys::derive(owner).map_err(|e| e.within(operation))?;

        let mut instructions = Vec::new();
        if existing.is_none() {
            instructions.push(create_associated_token_account_idempotent(
                &self.payer(),
                &owner_key,
                mint,
                &TOKEN_2022_PROGRAM_ID,
            ));
        }
        instructions.push(
            reallocate(
                &TOKEN_2022_PROGRAM_ID,
                &token,
                &self.payer(),
                &owner_key,
                &[],
                &[ExtensionType::ConfidentialTransferAccount],
            )
            .map_err(|e| build_error(operation, e))?,
        );
        let proof = build_pubkey_validity_proof_data(&keys.elgamal).map_err(|e| {
            Error::new(
                ErrorCode::InvalidInput,
                operation,
                format!("cannot prove the ElGamal key: {e}"),
            )
        })?;
        instructions.extend(
            ct_instruction::configure_account(
                &TOKEN_2022_PROGRAM_ID,
                &token,
                mint,
                &keys.ae.encrypt(0).into(),
                DEFAULT_MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER,
                &owner_key,
                &[],
                ProofLocation::InstructionOffset(1.try_into().expect("non-zero"), &proof),
            )
            .map_err(|e| build_error(operation, e))?,
        );
        let signature = self
            .sender(operation)
            .send(&instructions, &[owner], operation)
            .await?;
        Ok(ConfigureAccountResult {
            token_account: token,
            signature,
        })
    }

    /// Move `amount` of the owner's public balance into the confidential pending balance.
    pub async fn deposit(
        &self,
        owner: &dyn Signer,
        mint: &Pubkey,
        amount: u64,
    ) -> Result<Signature> {
        let operation = "deposit";
        check_amount(amount, operation, true)?;
        let decimals = read_mint(&self.rpc, &TOKEN_2022_PROGRAM_ID, mint, operation)
            .await?
            .decimals;
        let owner_key = owner.pubkey();
        let token = self.token_account(&owner_key, mint);
        let (account, ct) =
            read_configured_account(&self.rpc, &token, mint, operation, "your").await?;
        assert_can_receive(&ct, &token, operation, "your")?;
        if account.state.base.amount < amount {
            return Err(Error::new(
                ErrorCode::InsufficientFunds,
                operation,
                format!(
                    "the public balance of {token} is {}, less than {amount}",
                    account.state.base.amount
                ),
            ));
        }
        let instruction = ct_instruction::deposit(
            &TOKEN_2022_PROGRAM_ID,
            &token,
            mint,
            amount,
            decimals,
            &owner_key,
            &[],
        )
        .map_err(|e| build_error(operation, e))?;
        self.sender(operation)
            .send(&[instruction], &[owner], operation)
            .await
    }

    /// Move the owner's pending balance (incoming deposits and transfers) into the available
    /// balance.
    pub async fn apply_pending_balance(
        &self,
        owner: &dyn Signer,
        mint: &Pubkey,
    ) -> Result<Signature> {
        let operation = "apply_pending_balance";
        let owner_key = owner.pubkey();
        let token = self.token_account(&owner_key, mint);
        let keys = ConfidentialKeys::derive(owner).map_err(|e| e.within(operation))?;
        let update = self
            .pending_balance_update_inner(operation, mint, &token, &keys)
            .await?;
        let instruction = ct_instruction::apply_pending_balance(
            &TOKEN_2022_PROGRAM_ID,
            &token,
            update.expected_pending_balance_credit_counter,
            &PodAeCiphertext(update.new_decryptable_available_balance),
            &owner_key,
            &[],
        )
        .map_err(|e| build_error(operation, e))?;
        self.sender(operation)
            .send(&[instruction], &[owner], operation)
            .await
    }

    /// The owner's available confidential balance. Reads only; signs only the key derivation.
    pub async fn decrypt_balance(&self, owner: &dyn Signer, mint: &Pubkey) -> Result<u64> {
        let operation = "decrypt_balance";
        let keys = ConfidentialKeys::derive(owner).map_err(|e| e.within(operation))?;
        self.decrypt_balance_of(mint, &self.token_account(&owner.pubkey(), mint), &keys)
            .await
    }

    /// The available confidential balance of any token account, with its keys.
    pub async fn decrypt_balance_of(
        &self,
        mint: &Pubkey,
        token_account: &Pubkey,
        keys: &ConfidentialKeys,
    ) -> Result<u64> {
        let operation = "decrypt_balance";
        let (_, ct) =
            read_configured_account(&self.rpc, token_account, mint, operation, "the").await?;
        assert_keys_match(keys, &ct, token_account, operation)?;
        available_balance(&ct, &keys.ae, token_account, operation)
    }

    /// Confidentially transfer `amount` from the owner's account to `destination_owner`'s.
    ///
    /// The three proofs are verified into proof accounts first (four transactions), then the
    /// transfer closes them in its own transaction. If a step fails, the proof accounts created
    /// so far are closed and the error says which ([`Error::proof_accounts`]). The amount is also
    /// encrypted to the mint's auditor, when it has one, and a mint's transfer hook gets the
    /// accounts it asks for.
    pub async fn transfer(
        &self,
        owner: &dyn Signer,
        mint: &Pubkey,
        destination_owner: &Pubkey,
        amount: u64,
    ) -> Result<TransferResult> {
        let operation = "transfer";
        check_amount(amount, operation, true)?;
        let mint_info = read_mint(&self.rpc, &TOKEN_2022_PROGRAM_ID, mint, operation).await?;
        let owner_key = owner.pubkey();
        let source = self.token_account(&owner_key, mint);
        let destination = self.token_account(destination_owner, mint);
        let keys = ConfidentialKeys::derive(owner).map_err(|e| e.within(operation))?;

        let prepared = self
            .prepare_transfer_inner(
                operation,
                mint,
                &mint_info,
                &source,
                &keys,
                &destination,
                amount,
            )
            .await?;
        let mut instruction = prepared
            .instruction(&owner_key)
            .map_err(|e| e.within(operation))?;
        if mint_info.transfer_hook_program.is_some() {
            let extra = self
                .transfer_hook_accounts(mint, &source, &destination, &owner_key)
                .await;
            match extra {
                Ok(extra) => instruction.accounts.extend(extra),
                Err(e) => {
                    return Err(self
                        .abandon(
                            operation,
                            &prepared.proof_accounts(),
                            prepared.signatures.clone(),
                            e,
                        )
                        .await)
                }
            }
        }
        let (transfer_signature, signatures) = self
            .run_with_proofs(
                operation,
                instruction,
                owner,
                &prepared.proof_accounts(),
                prepared.signatures.clone(),
            )
            .await?;
        Ok(TransferResult {
            source_token_account: source,
            destination_token_account: destination,
            signatures,
            transfer_signature,
        })
    }

    /// Move `amount` of the owner's available confidential balance back to the public balance.
    /// Two proofs (three transactions), then the withdraw; cleanup as in [`Self::transfer`].
    pub async fn withdraw(
        &self,
        owner: &dyn Signer,
        mint: &Pubkey,
        amount: u64,
    ) -> Result<WithdrawResult> {
        let operation = "withdraw";
        check_amount(amount, operation, false)?;
        let mint_info = read_mint(&self.rpc, &TOKEN_2022_PROGRAM_ID, mint, operation).await?;
        let owner_key = owner.pubkey();
        let token = self.token_account(&owner_key, mint);
        let keys = ConfidentialKeys::derive(owner).map_err(|e| e.within(operation))?;

        let prepared = self
            .prepare_withdraw_inner(operation, mint, mint_info.decimals, &token, &keys, amount)
            .await?;
        let instruction = prepared
            .instruction(&owner_key)
            .map_err(|e| e.within(operation))?;
        let (withdraw_signature, signatures) = self
            .run_with_proofs(
                operation,
                instruction,
                owner,
                &prepared.proof_accounts(),
                prepared.signatures.clone(),
            )
            .await?;
        Ok(WithdrawResult {
            token_account: token,
            signatures,
            withdraw_signature,
        })
    }

    /// Find the proof accounts whose authority is the payer and close them, returning their rent:
    /// for proof accounts left by a transfer or withdraw whose process stopped partway. Do not
    /// run it while a transfer or withdraw paid by the same payer is in progress.
    pub async fn recover_proof_accounts(&self) -> Result<RecoverProofAccountsResult> {
        let operation = "recover_proof_accounts";
        let sender = self.sender(operation);
        let found = self
            .rpc
            .get_program_ui_accounts_with_config(
                &solana_zk_elgamal_proof_interface::id(),
                RpcProgramAccountsConfig {
                    // A proof account starts with its authority's public key.
                    filters: Some(vec![RpcFilterType::Memcmp(Memcmp::new_base58_encoded(
                        0,
                        self.payer().as_ref(),
                    ))]),
                    account_config: RpcAccountInfoConfig {
                        commitment: Some(self.rpc.commitment()),
                        // Only the addresses and lamports are needed.
                        encoding: Some(UiAccountEncoding::Base64),
                        data_slice: Some(UiDataSliceConfig {
                            offset: 0,
                            length: 0,
                        }),
                        ..RpcAccountInfoConfig::default()
                    },
                    ..RpcProgramAccountsConfig::default()
                },
            )
            .await
            .map_err(|e| sender.rpc_error(e))?;
        let addresses: Vec<Pubkey> = found.iter().map(|(address, _)| *address).collect();
        let (outcome, _) = close_proof_accounts(&sender, &addresses).await;
        let lamports = found
            .iter()
            .filter(|(address, _)| outcome.closed.contains(address))
            .map(|(_, account)| account.lamports)
            .sum();
        Ok(RecoverProofAccountsResult {
            closed: outcome.closed,
            left_open: outcome.left_open,
            lamports,
        })
    }

    // ---------------------------------------------------------------------------------------
    // Accounts owned by a program: the client prepares, the program signs through CPI.
    // ---------------------------------------------------------------------------------------

    /// Generate the proofs of a transfer from `source_token_account` (whose keys are `keys`) and
    /// verify them into proof accounts paid by the payer. Checks the same as [`Self::transfer`]
    /// before creating anything.
    pub async fn prepare_transfer(
        &self,
        mint: &Pubkey,
        source_token_account: &Pubkey,
        keys: &ConfidentialKeys,
        destination_token_account: &Pubkey,
        amount: u64,
    ) -> Result<PreparedTransfer> {
        let operation = "prepare_transfer";
        check_amount(amount, operation, true)?;
        let mint_info = read_mint(&self.rpc, &TOKEN_2022_PROGRAM_ID, mint, operation).await?;
        self.prepare_transfer_inner(
            operation,
            mint,
            &mint_info,
            source_token_account,
            keys,
            destination_token_account,
            amount,
        )
        .await
    }

    /// Generate the proofs of a withdraw and verify them into proof accounts.
    pub async fn prepare_withdraw(
        &self,
        mint: &Pubkey,
        token_account: &Pubkey,
        keys: &ConfidentialKeys,
        amount: u64,
    ) -> Result<PreparedWithdraw> {
        let operation = "prepare_withdraw";
        check_amount(amount, operation, false)?;
        let decimals = read_mint(&self.rpc, &TOKEN_2022_PROGRAM_ID, mint, operation)
            .await?
            .decimals;
        self.prepare_withdraw_inner(operation, mint, decimals, token_account, keys, amount)
            .await
    }

    /// Prove `keys`' ElGamal public key into a proof account, for configuring an account whose
    /// owner signs through a program.
    pub async fn prepare_configure(&self, keys: &ConfidentialKeys) -> Result<PreparedConfigure> {
        let operation = "prepare_configure";
        let proof = build_pubkey_validity_proof_data(&keys.elgamal).map_err(|e| {
            Error::new(
                ErrorCode::InvalidInput,
                operation,
                format!("cannot prove the ElGamal key: {e}"),
            )
        })?;
        let sender = self.sender(operation);
        let mut setup = ProofSetup::new(&sender);
        let account = match setup
            .create(ProofInstruction::VerifyPubkeyValidity, &proof, false)
            .await
        {
            Ok(account) => account,
            Err(e) => return Err(setup.fail(e).await),
        };
        Ok(PreparedConfigure {
            pubkey_validity_proof: account,
            elgamal_pubkey: keys.elgamal_pubkey().into(),
            decryptable_zero_balance: PodAeCiphertext::from(keys.ae.encrypt(0)).0,
            signatures: setup.signatures,
        })
    }

    /// What `ApplyPendingBalance` needs for `token_account`, computed with its keys.
    pub async fn pending_balance_update(
        &self,
        mint: &Pubkey,
        token_account: &Pubkey,
        keys: &ConfidentialKeys,
    ) -> Result<PendingBalanceUpdate> {
        self.pending_balance_update_inner("pending_balance_update", mint, token_account, keys)
            .await
    }

    /// The extra accounts a mint's transfer hook needs for a transfer, to append to the transfer
    /// instruction or to pass to a program that makes the transfer (as remaining accounts).
    /// Empty when the mint has no transfer hook.
    pub async fn transfer_hook_accounts(
        &self,
        mint: &Pubkey,
        source_token_account: &Pubkey,
        destination_token_account: &Pubkey,
        authority: &Pubkey,
    ) -> Result<Vec<AccountMeta>> {
        let operation = "transfer_hook_accounts";
        let base = [
            *source_token_account,
            *mint,
            *destination_token_account,
            *authority,
        ];
        let mut instruction = Instruction {
            program_id: TOKEN_2022_PROGRAM_ID,
            accounts: base
                .iter()
                .map(|k| AccountMeta::new_readonly(*k, false))
                .collect(),
            data: Vec::new(),
        };
        let rpc = self.rpc.clone();
        spl_token_2022::offchain::add_extra_account_metas(
            &mut instruction,
            source_token_account,
            mint,
            destination_token_account,
            authority,
            u64::MAX, // what Token-2022 passes the hook for a confidential transfer
            move |address| {
                let rpc = rpc.clone();
                async move {
                    rpc.get_account_with_commitment(&address, rpc.commitment())
                        .await
                        .map(|r| r.value.map(|a| a.data))
                        .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
                }
            },
        )
        .await
        .map_err(|e| {
            Error::new(
                ErrorCode::AccountNotFound,
                operation,
                format!("cannot resolve the accounts of mint {mint}'s transfer hook (is its extra-account-meta list set up?): {e}"),
            )
        })?;
        Ok(instruction.accounts.split_off(base.len()))
    }

    /// Close proof accounts whose authority is the payer, returning their rent to it.
    pub async fn close_proof_accounts(&self, accounts: &[Pubkey]) -> ProofAccounts {
        close_proof_accounts(&self.sender("close_proof_accounts"), accounts)
            .await
            .0
    }

    // ---------------------------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    async fn prepare_transfer_inner(
        &self,
        operation: &'static str,
        mint: &Pubkey,
        mint_info: &MintInfo,
        source: &Pubkey,
        keys: &ConfidentialKeys,
        destination: &Pubkey,
        amount: u64,
    ) -> Result<PreparedTransfer> {
        let (_, source_ct) =
            read_configured_account(&self.rpc, source, mint, operation, "your").await?;
        assert_keys_match(keys, &source_ct, source, operation)?;
        let (_, destination_ct) =
            read_configured_account(&self.rpc, destination, mint, operation, "the recipient's")
                .await?;
        assert_can_receive(&destination_ct, destination, operation, "the recipient's")?;
        let available = available_balance(&source_ct, &keys.ae, source, operation)?;
        if amount > available {
            return Err(Error::new(
                ErrorCode::InsufficientFunds,
                operation,
                format!("the available confidential balance of {source} is {available}, less than {amount}"),
            ));
        }
        let destination_pubkey =
            ElGamalPubkey::try_from(destination_ct.elgamal_pubkey).map_err(|_| {
                Error::new(
                    ErrorCode::InvalidInput,
                    operation,
                    format!("{destination} has a malformed ElGamal key"),
                )
            })?;

        let info = TransferAccountInfo::new(&source_ct);
        let TransferProofData {
            equality_proof_data,
            ciphertext_validity_proof_data_with_ciphertext: validity,
            range_proof_data,
        } = info
            .generate_split_transfer_proof_data(
                amount,
                &keys.elgamal,
                &keys.ae,
                &destination_pubkey,
                mint_info.auditor.as_ref(),
            )
            .map_err(|e| proof_error(operation, e))?;
        let new_balance = info
            .new_decryptable_available_balance(amount, &keys.ae)
            .map_err(|e| proof_error(operation, e))?;

        let sender = self.sender(operation);
        let mut setup = ProofSetup::new(&sender);
        let created = async {
            let equality = setup
                .create(
                    ProofInstruction::VerifyCiphertextCommitmentEquality,
                    &equality_proof_data,
                    false,
                )
                .await?;
            let validity_account = setup
                .create(
                    ProofInstruction::VerifyBatchedGroupedCiphertext3HandlesValidity,
                    &validity.proof_data,
                    false,
                )
                .await?;
            let range = setup
                .create(
                    ProofInstruction::VerifyBatchedRangeProofU128,
                    &range_proof_data,
                    true,
                )
                .await?;
            Ok::<_, Error>((equality, validity_account, range))
        }
        .await;
        let (equality_proof, ciphertext_validity_proof, range_proof) = match created {
            Ok(accounts) => accounts,
            Err(e) => return Err(setup.fail(e).await),
        };
        Ok(PreparedTransfer {
            mint: *mint,
            source_token_account: *source,
            destination_token_account: *destination,
            equality_proof,
            ciphertext_validity_proof,
            range_proof,
            new_decryptable_available_balance: PodAeCiphertext::from(new_balance).0,
            auditor_ciphertext_lo: validity.ciphertext_lo.0,
            auditor_ciphertext_hi: validity.ciphertext_hi.0,
            signatures: setup.signatures,
        })
    }

    async fn prepare_withdraw_inner(
        &self,
        operation: &'static str,
        mint: &Pubkey,
        decimals: u8,
        token: &Pubkey,
        keys: &ConfidentialKeys,
        amount: u64,
    ) -> Result<PreparedWithdraw> {
        let (_, ct) = read_configured_account(&self.rpc, token, mint, operation, "your").await?;
        assert_keys_match(keys, &ct, token, operation)?;
        let available = available_balance(&ct, &keys.ae, token, operation)?;
        if amount > available {
            return Err(Error::new(
                ErrorCode::InsufficientFunds,
                operation,
                format!("the available confidential balance of {token} is {available}, less than {amount}"),
            ));
        }
        let info = WithdrawAccountInfo::new(&ct);
        let WithdrawProofData {
            equality_proof_data,
            range_proof_data,
        } = info
            .generate_proof_data(amount, &keys.elgamal, &keys.ae)
            .map_err(|e| proof_error(operation, e))?;
        let new_balance = info
            .new_decryptable_available_balance(amount, &keys.ae)
            .map_err(|e| proof_error(operation, e))?;

        let sender = self.sender(operation);
        let mut setup = ProofSetup::new(&sender);
        let created = async {
            let equality = setup
                .create(
                    ProofInstruction::VerifyCiphertextCommitmentEquality,
                    &equality_proof_data,
                    false,
                )
                .await?;
            let range = setup
                .create(
                    ProofInstruction::VerifyBatchedRangeProofU64,
                    &range_proof_data,
                    true,
                )
                .await?;
            Ok::<_, Error>((equality, range))
        }
        .await;
        let (equality_proof, range_proof) = match created {
            Ok(accounts) => accounts,
            Err(e) => return Err(setup.fail(e).await),
        };
        Ok(PreparedWithdraw {
            mint: *mint,
            token_account: *token,
            amount,
            decimals,
            equality_proof,
            range_proof,
            new_decryptable_available_balance: PodAeCiphertext::from(new_balance).0,
            signatures: setup.signatures,
        })
    }

    async fn pending_balance_update_inner(
        &self,
        operation: &'static str,
        mint: &Pubkey,
        token: &Pubkey,
        keys: &ConfidentialKeys,
    ) -> Result<PendingBalanceUpdate> {
        let (_, ct) = read_configured_account(&self.rpc, token, mint, operation, "your").await?;
        assert_keys_match(keys, &ct, token, operation)?;
        pending_update(&ct, keys, token, operation)
    }

    /// Send `instruction` (signed by `owner`) together with closing the proof accounts when it
    /// fits in one transaction, or followed by a separate close. On failure, close them anyway.
    async fn run_with_proofs(
        &self,
        operation: &'static str,
        instruction: Instruction,
        owner: &dyn Signer,
        proof_accounts: &[Pubkey],
        mut signatures: Vec<Signature>,
    ) -> Result<(Signature, Vec<Signature>)> {
        let sender = self.sender(operation);
        let mut together = vec![instruction.clone()];
        together.extend(close_instructions(&self.payer(), proof_accounts));
        let closes_with_it = sender.fits(&together, 0);
        let sent = if closes_with_it {
            sender.send(&together, &[owner], operation).await
        } else {
            sender.send(&[instruction], &[owner], operation).await
        };
        let signature = match sent {
            Ok(signature) => signature,
            Err(e) => return Err(self.abandon(operation, proof_accounts, signatures, e).await),
        };
        signatures.push(signature);
        if !closes_with_it {
            let (outcome, closing) = close_proof_accounts(&sender, proof_accounts).await;
            signatures.extend(closing);
            // The transfer went through; proof accounts left open are only rent, which
            // recover_proof_accounts gets back later. Not an error.
            let _ = outcome;
        }
        Ok((signature, signatures))
    }

    /// Close the proof accounts of a transfer or withdraw that will not happen, and attach the
    /// outcome to `error`.
    async fn abandon(
        &self,
        operation: &'static str,
        proof_accounts: &[Pubkey],
        mut signatures: Vec<Signature>,
        error: Error,
    ) -> Error {
        let (outcome, closing) =
            close_proof_accounts(&self.sender(operation), proof_accounts).await;
        signatures.extend(closing);
        error
            .with_proof_accounts(outcome)
            .with_signatures(signatures)
    }
}

fn pending_update(
    ct: &ConfidentialTransferAccount,
    keys: &ConfidentialKeys,
    token: &Pubkey,
    operation: &'static str,
) -> Result<PendingBalanceUpdate> {
    let info = ApplyPendingBalanceAccountInfo::new(ct);
    let new_balance = info.new_decryptable_available_balance(keys.elgamal.secret(), &keys.ae).map_err(|e| {
        Error::new(
            ErrorCode::DecryptionFailed,
            operation,
            format!(
                "could not decrypt the pending balance of {token} ({e}). Incoming amounts may add up to more than can \
                 be decrypted at once (about 2^48 base units)."
            ),
        )
    })?;
    Ok(PendingBalanceUpdate {
        expected_pending_balance_credit_counter: info.pending_balance_credit_counter(),
        new_decryptable_available_balance: PodAeCiphertext::from(new_balance).0,
    })
}

fn check_amount(amount: u64, operation: &'static str, capped: bool) -> Result<()> {
    if amount == 0 {
        return Err(Error::new(
            ErrorCode::InvalidInput,
            operation,
            "the amount must be more than zero",
        ));
    }
    if capped && amount > MAXIMUM_DEPOSIT_TRANSFER_AMOUNT {
        return Err(Error::new(
            ErrorCode::AmountTooLarge,
            operation,
            format!("{amount} is more than one deposit or transfer can carry ({MAXIMUM_DEPOSIT_TRANSFER_AMOUNT}); split it"),
        ));
    }
    Ok(())
}

fn proof_error(operation: &'static str, e: impl std::fmt::Display) -> Error {
    Error::new(
        ErrorCode::DecryptionFailed,
        operation,
        format!("cannot generate the proofs from the account's balance: {e}"),
    )
}

fn build_error(operation: &'static str, e: impl std::fmt::Display) -> Error {
    Error::new(
        ErrorCode::InvalidInput,
        operation,
        format!("cannot build the instruction: {e}"),
    )
}
