// SPDX-License-Identifier: Apache-2.0
//
// Confidential-transfer key derivation.
//
// The ElGamal (balance/amount encryption) and AES (decryptable-balance) keys
// are derived deterministically from the account owner's wallet signer and
// bound to the (owner, mint) pair. They are therefore recoverable from the
// wallet alone and never need to be stored. This mirrors the reference
// derivation in solana-program/token-2022 and its Rust solana-zk-sdk vector.
import {
  createSignableMessage,
  getAddressDecoder,
  getAddressEncoder,
  getTupleEncoder,
  type Address,
  type MessagePartialSigner,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { AeKey, ElGamalKeypair } from "@solana/zk-sdk/node";

/** Public ElGamal key (as an Address) plus the 32-byte ElGamal secret key. */
export type DerivedElGamalKeypair = Readonly<{
  elgamalPubkey: Address;
  secretKey: Uint8Array;
}>;

/** The WASM zk-sdk key objects consumed by the confidential-transfer builders. */
export type ConfidentialKeypairs = Readonly<{
  elgamalKeypair: ElGamalKeypair;
  aesKey: AeKey;
}>;

function ownerMintSeed(owner: Address, mint: Address): ReadonlyUint8Array {
  return getTupleEncoder([getAddressEncoder(), getAddressEncoder()]).encode([owner, mint]);
}

async function signDerivationMessage(
  signer: MessagePartialSigner,
  message: Uint8Array,
): Promise<Uint8Array> {
  const [signatures] = await signer.signMessages([createSignableMessage(message)]);
  const signature = signatures?.[signer.address];
  if (signature == null) {
    throw new Error(`Signer ${signer.address} did not return a signature`);
  }
  return new Uint8Array(signature);
}

/** Derive an ElGamal keypair from a signer (optionally domain-separated by a public seed). */
export async function deriveElGamalKeypair({
  signer,
  publicSeed = new Uint8Array(0),
}: {
  signer: MessagePartialSigner;
  publicSeed?: ReadonlyUint8Array;
}): Promise<DerivedElGamalKeypair> {
  const message = ElGamalKeypair.signerMessage(new Uint8Array(publicSeed));
  const signature = await signDerivationMessage(signer, message);
  const keypair = ElGamalKeypair.fromSignature(signature);
  const secretKey = new Uint8Array(keypair.secret().toBytes());
  const elgamalPubkey = getAddressDecoder().decode(new Uint8Array(keypair.pubkey().toBytes()));
  return { elgamalPubkey, secretKey };
}

/** Derive an AES-128 key from a signer (optionally domain-separated by a public seed). */
export async function deriveAeKey({
  signer,
  publicSeed = new Uint8Array(0),
}: {
  signer: MessagePartialSigner;
  publicSeed?: ReadonlyUint8Array;
}): Promise<Uint8Array> {
  const message = AeKey.signerMessage(new Uint8Array(publicSeed));
  const signature = await signDerivationMessage(signer, message);
  return new Uint8Array(AeKey.fromSignature(signature).toBytes());
}

/** Derive the ElGamal keypair bound to (owner, mint). */
export async function deriveElGamalKeypairForOwnerMint(input: {
  signer: MessagePartialSigner;
  owner: Address;
  mint: Address;
}): Promise<DerivedElGamalKeypair> {
  return deriveElGamalKeypair({
    signer: input.signer,
    publicSeed: ownerMintSeed(input.owner, input.mint),
  });
}

/** Derive the AES key bound to (owner, mint). */
export async function deriveAeKeyForOwnerMint(input: {
  signer: MessagePartialSigner;
  owner: Address;
  mint: Address;
}): Promise<Uint8Array> {
  return deriveAeKey({ signer: input.signer, publicSeed: ownerMintSeed(input.owner, input.mint) });
}

/**
 * Derive the WASM zk-sdk ElGamal keypair and AES key for a confidential-transfer
 * account, bound to (owner, mint). These objects are what the instruction
 * builders and proof generators consume directly.
 */
export async function deriveConfidentialKeypairs(input: {
  signer: MessagePartialSigner;
  owner: Address;
  mint: Address;
}): Promise<ConfidentialKeypairs> {
  const seed = new Uint8Array(ownerMintSeed(input.owner, input.mint));
  const elgamalSignature = await signDerivationMessage(input.signer, ElGamalKeypair.signerMessage(seed));
  const aeSignature = await signDerivationMessage(input.signer, AeKey.signerMessage(seed));
  return {
    elgamalKeypair: ElGamalKeypair.fromSignature(elgamalSignature),
    aesKey: AeKey.fromSignature(aeSignature),
  };
}
