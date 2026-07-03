// SPDX-License-Identifier: Apache-2.0
//! Confidential-transfer key derivation.
//!
//! An account's ElGamal keypair and AES key are derived deterministically from
//! the owner's signer, bound to the token-account address — recoverable from the
//! wallet alone and never stored. Mirrors the derivation in the TypeScript SDK.
use solana_sdk::{pubkey::Pubkey, signer::Signer};
use solana_zk_sdk::encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair};

/// Derive the `(ElGamal keypair, AES key)` for a confidential-transfer account
/// from its owner's signer, bound to the token-account address.
pub fn derive_account_keys(
    owner: &dyn Signer,
    token_account: &Pubkey,
) -> Result<(ElGamalKeypair, AeKey), Box<dyn std::error::Error>> {
    let seed = token_account.to_bytes();
    let elgamal_keypair = ElGamalKeypair::new_from_signer(owner, &seed)?;
    let aes_key = AeKey::new_from_signer(owner, &seed)?;
    Ok((elgamal_keypair, aes_key))
}
