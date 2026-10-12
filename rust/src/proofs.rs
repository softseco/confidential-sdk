// SPDX-License-Identifier: Apache-2.0
//! Proof context-state accounts: a transfer or withdraw verifies its zero-knowledge proofs into
//! temporary accounts of the ZK ElGamal Proof Program first (the proofs are too large to travel
//! with the transfer), and closes them afterwards to get their rent back.
use std::mem::size_of;

use bytemuck::Pod;
use solana_sdk::{
    pubkey::Pubkey,
    signature::Signature,
    signer::{keypair::Keypair, Signer},
};
use solana_system_interface::instruction as system_instruction;
use solana_zk_elgamal_proof_interface::{
    instruction::{close_context_state, ContextStateInfo, ProofInstruction},
    proof_data::ZkProofData,
    state::ProofContextState,
};

use crate::error::{Error, ProofAccounts, Result};
use crate::send::Sender;

/// How many close instructions go into one transaction.
const CLOSES_PER_TRANSACTION: usize = 8;

/// Creates proof accounts one after the other and remembers what it created, so that a failure
/// partway can be cleaned up.
pub(crate) struct ProofSetup<'a> {
    sender: &'a Sender<'a>,
    /// Created and verified: these can be closed.
    pub verified: Vec<Pubkey>,
    /// Created, but the proof was not verified into them: they cannot be closed.
    pub unverified: Vec<Pubkey>,
    pub signatures: Vec<Signature>,
}

impl<'a> ProofSetup<'a> {
    pub fn new(sender: &'a Sender<'a>) -> Self {
        Self {
            sender,
            verified: Vec::new(),
            unverified: Vec::new(),
            signatures: Vec::new(),
        }
    }

    /// Create a context-state account and verify `proof` into it. `split` sends the account
    /// creation and the verification as two transactions, for proofs too large to share one.
    pub async fn create<ZK: Pod + ZkProofData<U>, U: Pod>(
        &mut self,
        instruction: ProofInstruction,
        proof: &ZK,
        split: bool,
    ) -> Result<Pubkey> {
        let payer = self.sender.payer.pubkey();
        let account = Keypair::new();
        let address = account.pubkey();
        let space = size_of::<ProofContextState<U>>();
        let rent = self
            .sender
            .rpc
            .get_minimum_balance_for_rent_exemption(space)
            .await
            .map_err(|e| self.sender.rpc_error(e).with_step("proofs"))?;
        let create = system_instruction::create_account(
            &payer,
            &address,
            rent,
            space as u64,
            &solana_zk_elgamal_proof_interface::id(),
        );
        let verify = instruction.encode_verify_proof(
            Some(ContextStateInfo {
                context_state_account: &address,
                context_state_authority: &payer,
            }),
            proof,
        );
        if split {
            self.signatures
                .push(self.sender.send(&[create], &[&account], "proofs").await?);
            match self.sender.send(&[verify], &[], "proofs").await {
                Ok(signature) => self.signatures.push(signature),
                Err(e) => {
                    self.unverified.push(address);
                    return Err(e);
                }
            }
        } else {
            self.signatures.push(
                self.sender
                    .send(&[create, verify], &[&account], "proofs")
                    .await?,
            );
        }
        self.verified.push(address);
        Ok(address)
    }

    /// Close what was created and attach the outcome to `error`.
    pub async fn fail(self, error: Error) -> Error {
        let (mut accounts, closing_signatures) =
            close_proof_accounts(self.sender, &self.verified).await;
        accounts.left_open.extend(self.unverified);
        let mut signatures = self.signatures;
        signatures.extend(closing_signatures);
        error
            .with_proof_accounts(accounts)
            .with_signatures(signatures)
    }
}

/// Close proof accounts whose authority is the sender's payer; their rent goes to the payer.
/// Closes several per transaction, and one by one when a batch fails.
pub(crate) async fn close_proof_accounts(
    sender: &Sender<'_>,
    accounts: &[Pubkey],
) -> (ProofAccounts, Vec<Signature>) {
    let payer = sender.payer.pubkey();
    let close = |account: &Pubkey| {
        close_context_state(
            ContextStateInfo {
                context_state_account: account,
                context_state_authority: &payer,
            },
            &payer,
        )
    };
    let mut outcome = ProofAccounts::default();
    let mut signatures = Vec::new();
    for batch in accounts.chunks(CLOSES_PER_TRANSACTION) {
        let instructions: Vec<_> = batch.iter().map(close).collect();
        match sender
            .send(&instructions, &[], "close proof accounts")
            .await
        {
            Ok(signature) => {
                signatures.push(signature);
                outcome.closed.extend_from_slice(batch);
            }
            Err(_) if batch.len() > 1 => {
                for account in batch {
                    match sender
                        .send(&[close(account)], &[], "close proof accounts")
                        .await
                    {
                        Ok(signature) => {
                            signatures.push(signature);
                            outcome.closed.push(*account);
                        }
                        Err(_) => outcome.left_open.push(*account),
                    }
                }
            }
            Err(_) => outcome.left_open.extend_from_slice(batch),
        }
    }
    (outcome, signatures)
}

/// The instructions that close `accounts`, for appending to the transfer's own transaction.
pub(crate) fn close_instructions(
    payer: &Pubkey,
    accounts: &[Pubkey],
) -> Vec<solana_sdk::instruction::Instruction> {
    accounts
        .iter()
        .map(|account| {
            close_context_state(
                ContextStateInfo {
                    context_state_account: account,
                    context_state_authority: payer,
                },
                payer,
            )
        })
        .collect()
}
