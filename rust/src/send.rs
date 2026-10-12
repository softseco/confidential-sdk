// SPDX-License-Identifier: Apache-2.0
//! Sending transactions: priority fee where there is room, simulation first (so a failure comes
//! with the program logs), then send and confirm; an expired blockhash is retried when asked.
use solana_client::{
    client_error::ClientError, nonblocking::rpc_client::RpcClient,
    rpc_config::RpcSimulateTransactionConfig,
};
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_sdk::{
    hash::Hash,
    instruction::Instruction,
    message::Message,
    pubkey::Pubkey,
    signature::Signature,
    signer::Signer,
    transaction::{Transaction, TransactionError},
};

use crate::error::{Error, ErrorCode, Result};

/// Largest transaction on the wire.
const PACKET_DATA_SIZE: usize = 1232;

pub(crate) struct Sender<'a> {
    pub rpc: &'a RpcClient,
    pub payer: &'a dyn Signer,
    pub compute_unit_price: Option<u64>,
    pub max_retries: u32,
    pub operation: &'static str,
}

impl Sender<'_> {
    pub fn rpc_error(&self, e: ClientError) -> Error {
        Error::new(
            ErrorCode::Rpc,
            self.operation,
            format!("RPC request failed: {e}"),
        )
        .with_source(e)
    }

    /// Send one transaction of `instructions`, signed by the payer and those of `signers` the
    /// instructions need.
    pub async fn send(
        &self,
        instructions: &[Instruction],
        signers: &[&dyn Signer],
        step: &'static str,
    ) -> Result<Signature> {
        let mut attempt = 0;
        loop {
            match self.send_once(instructions, signers, step).await {
                Err(e)
                    if e.code() == ErrorCode::TransactionExpired && attempt < self.max_retries =>
                {
                    attempt += 1
                }
                other => return other,
            }
        }
    }

    /// True if the instructions fit in one transaction with these signers.
    pub fn fits(&self, instructions: &[Instruction], signer_count: usize) -> bool {
        let message = Message::new(instructions, Some(&self.payer.pubkey()));
        wire_size(
            &message,
            signer_count.max(usize::from(message.header.num_required_signatures)),
        ) <= PACKET_DATA_SIZE
    }

    async fn send_once(
        &self,
        instructions: &[Instruction],
        signers: &[&dyn Signer],
        step: &'static str,
    ) -> Result<Signature> {
        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .await
            .map_err(|e| self.rpc_error(e))?;
        let transaction = self.build(instructions, signers, blockhash)?;

        let simulation = self
            .rpc
            .simulate_transaction_with_config(
                &transaction,
                RpcSimulateTransactionConfig {
                    sig_verify: false,
                    commitment: Some(self.rpc.commitment()),
                    ..RpcSimulateTransactionConfig::default()
                },
            )
            .await
            .map_err(|e| self.rpc_error(e))?
            .value;
        if let Some(err) = simulation.err {
            let logs = simulation.logs.unwrap_or_default();
            let err = TransactionError::from(err);
            return Err(self
                .transaction_error(&err, step, "failed simulation")
                .with_logs(logs));
        }

        self.rpc
            .send_and_confirm_transaction(&transaction)
            .await
            .map_err(|e| {
                let text = e.to_string();
                match e.get_transaction_error() {
                    Some(err) => self.transaction_error(&err, step, "failed").with_source(e),
                    None if is_expiry(&text) => Error::new(
                        ErrorCode::TransactionExpired,
                        self.operation,
                        format!(
                            "{} was not confirmed before its blockhash expired: {text}",
                            self.what(step)
                        ),
                    )
                    .with_step(step)
                    .with_source(e),
                    None => self.rpc_error(e).with_step(step),
                }
            })
    }

    fn what(&self, step: &'static str) -> String {
        if step == self.operation {
            "the transaction".into()
        } else {
            format!("step \"{step}\"")
        }
    }

    fn transaction_error(&self, err: &TransactionError, step: &'static str, verb: &str) -> Error {
        let code = if matches!(err, TransactionError::BlockhashNotFound) {
            ErrorCode::TransactionExpired
        } else {
            ErrorCode::TransactionFailed
        };
        Error::new(
            code,
            self.operation,
            format!("{} {verb}: {err}", self.what(step)),
        )
        .with_step(step)
    }

    fn build(
        &self,
        instructions: &[Instruction],
        signers: &[&dyn Signer],
        blockhash: Hash,
    ) -> Result<Transaction> {
        if let Some(price) = self.compute_unit_price.filter(|p| *p > 0) {
            let mut priced = Vec::with_capacity(instructions.len() + 1);
            priced.push(ComputeBudgetInstruction::set_compute_unit_price(price));
            priced.extend_from_slice(instructions);
            // The range-proof transactions have no room for the fee instruction; they go without.
            if self.fits(&priced, 0) {
                return self.sign(&priced, signers, blockhash);
            }
        }
        self.sign(instructions, signers, blockhash)
    }

    fn sign(
        &self,
        instructions: &[Instruction],
        signers: &[&dyn Signer],
        blockhash: Hash,
    ) -> Result<Transaction> {
        let message = Message::new(instructions, Some(&self.payer.pubkey()));
        let required: Vec<Pubkey> =
            message.account_keys[..usize::from(message.header.num_required_signatures)].to_vec();
        let mut chosen: Vec<&dyn Signer> = Vec::new();
        for signer in std::iter::once(self.payer).chain(signers.iter().copied()) {
            let key = signer.pubkey();
            if required.contains(&key) && !chosen.iter().any(|s| s.pubkey() == key) {
                chosen.push(signer);
            }
        }
        let mut transaction = Transaction::new_unsigned(message);
        transaction.try_sign(&chosen, blockhash).map_err(|e| {
            Error::new(
                ErrorCode::InvalidInput,
                self.operation,
                format!("cannot sign the transaction: {e}"),
            )
            .with_source(e)
        })?;
        Ok(transaction)
    }
}

fn wire_size(message: &Message, signatures: usize) -> usize {
    // short_vec length prefix (1 byte below 128 signatures) + signatures + message
    1 + 64 * signatures + message.serialize().len()
}

fn is_expiry(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    text.contains("blockhash not found")
        || text.contains("blockhashnotfound")
        || text.contains("unable to confirm transaction")
}
