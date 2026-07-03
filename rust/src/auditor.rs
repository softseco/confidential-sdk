// SPDX-License-Identifier: Apache-2.0
//! Auditor-key selective disclosure.
//!
//! A Token-2022 mint can designate an auditor ElGamal public key. When set,
//! every confidential transfer on that mint also encrypts the amount to the
//! auditor, who can recover it here with their ElGamal secret key — without
//! being able to spend, and without affecting anyone else's confidentiality.
//! Mirrors the TypeScript SDK's auditor utilities.
use solana_sdk::signer::Signer;
use solana_zk_sdk::encryption::elgamal::{ElGamalCiphertext, ElGamalKeypair};

/// Derive the auditor's ElGamal keypair from its wallet signer. The key is
/// mint-independent, so it is recoverable from the wallet alone and never stored.
pub fn derive_auditor_keypair(
    signer: &dyn Signer,
) -> Result<ElGamalKeypair, Box<dyn std::error::Error>> {
    ElGamalKeypair::new_from_signer(signer, &[])
}

/// Recover a confidential transfer's amount from its auditor ciphertext (the
/// lo/hi halves), using the auditor's ElGamal secret key.
pub fn decrypt_auditor_amount(
    auditor_keypair: &ElGamalKeypair,
    ciphertext_lo: &ElGamalCiphertext,
    ciphertext_hi: &ElGamalCiphertext,
) -> Result<u64, Box<dyn std::error::Error>> {
    let secret = auditor_keypair.secret();
    let lo = secret
        .decrypt_u32(ciphertext_lo)
        .ok_or("decrypt_auditor_amount: failed to decrypt the lo ciphertext")?;
    let hi = secret
        .decrypt_u32(ciphertext_hi)
        .ok_or("decrypt_auditor_amount: failed to decrypt the hi ciphertext")?;
    Ok(lo + (hi << 16))
}
