// SPDX-License-Identifier: Apache-2.0
//! Confidential-balances key derivation.
//!
//! An account's ElGamal keypair and AES key come from the standard derivation:
//! one signature over the constant message `solana-conf-bal/v1`, expanded
//! through a shared HKDF-SHA512 chain. The keys are bound to the signing wallet
//! alone — one ElGamal keypair and one AES key across every mint and token
//! account the wallet owns — so they are recoverable from the wallet, never
//! stored, and byte-identical to what the TypeScript SDK, the Token-2022
//! clients and every other standard client derive for the same wallet.
//!
//! Before 2.0.0 this crate seeded the derivation with the token-account address
//! while the TypeScript SDK seeded it with `(owner, mint)`. The two schemes
//! disagreed, so an account configured with one could not be read with the
//! other; see CHANGELOG.md for the migration.
use solana_sdk::signer::Signer;
use solana_zk_sdk::encryption::{
    auth_encryption::AeKey, derivation::derive_confidential_keys, elgamal::ElGamalKeypair,
};

/// Derive the wallet's `(ElGamal keypair, AES key)` for confidential balances.
///
/// The derivation takes no seed: the same wallet yields the same keys for every
/// mint and token account, which is what makes them interoperable with other
/// standard clients.
pub fn derive_account_keys(
    owner: &dyn Signer,
) -> Result<(ElGamalKeypair, AeKey), Box<dyn std::error::Error>> {
    // The empty public seed is the standard derivation: the signed message is
    // `HKDF_SALT` alone, i.e. exactly `solana-conf-bal/v1`. A non-empty seed
    // appends to that message and produces keys no other standard client can
    // reproduce for the same wallet.
    derive_confidential_keys(owner, b"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::signature::Keypair;

    // Cross-language vector. The TypeScript SDK pins the same signer and the
    // same expected output in test/keys.test.ts ("matches the pinned standard
    // derivation vector"). If either half drifts away from the standard
    // derivation, one of the two tests fails \u2014 which is exactly the check
    // 1.x did not have, and why the two bindings could disagree unnoticed.
    const VECTOR_SECRET_KEY: [u8; 32] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31, 32,
    ];
    const VECTOR_ELGAMAL_SECRET_KEY: [u8; 32] = [
        18, 9, 170, 121, 195, 51, 117, 115, 170, 156, 1, 205, 213, 187, 10, 37, 32, 121, 194, 13,
        155, 15, 88, 37, 156, 188, 30, 250, 119, 108, 238, 6,
    ];
    const VECTOR_AE_KEY: [u8; 16] = [
        95, 104, 35, 1, 89, 137, 42, 78, 42, 160, 111, 199, 94, 5, 99, 223,
    ];

    #[test]
    fn matches_the_typescript_standard_derivation_vector() {
        let owner = Keypair::new_from_array(VECTOR_SECRET_KEY);
        let (elgamal, ae_key) = derive_account_keys(&owner).expect("derivation failed");
        assert_eq!(
            elgamal.secret().as_bytes(),
            &VECTOR_ELGAMAL_SECRET_KEY,
            "ElGamal secret key does not match the TypeScript vector"
        );
        assert_eq!(
            <[u8; 16]>::from(&ae_key),
            VECTOR_AE_KEY,
            "AES key does not match the TypeScript vector"
        );
    }

    #[test]
    fn is_deterministic_and_wallet_bound() {
        let owner = Keypair::new_from_array(VECTOR_SECRET_KEY);
        let (a, _) = derive_account_keys(&owner).unwrap();
        let (b, _) = derive_account_keys(&owner).unwrap();
        assert_eq!(a.secret().as_bytes(), b.secret().as_bytes());
    }
}
