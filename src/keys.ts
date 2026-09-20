// SPDX-License-Identifier: Apache-2.0
//
// Confidential-balances key derivation.
//
// The ElGamal key (balance and amount encryption) and the AES key (the
// `decryptable_available_balance` fast path) are derived from a single ed25519
// signature over the constant message `solana-conf-bal/v1`, expanded through a
// shared HKDF-SHA512 chain. The derivation is bound to the signing wallet
// alone: one ElGamal keypair and one AES key across every mint and token
// account the wallet owns, byte-identical to what the Rust `solana-zk-sdk`,
// the Token-2022 clients and every other standard client derive for the same
// wallet. Keys are therefore recoverable from the wallet and never stored.
//
// Before 2.0.0 this SDK scoped keys by (owner, mint) while its Rust twin
// scoped them by token account. Both schemes are superseded, and because they
// disagreed, an account configured with one could not be read with the other.
// Accounts configured by 1.x must be re-configured; see CHANGELOG.md.
import {
  createSignableMessage,
  getAddressDecoder,
  getAddressEncoder,
  type Address,
  type MessagePartialSigner,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { AeKey, ConfidentialKeys, ElGamalKeypair } from "@solana/zk-sdk/node";

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

async function confidentialKeysFrom(
  signer: MessagePartialSigner,
  message: Uint8Array,
): Promise<ConfidentialKeypairs> {
  const keys = ConfidentialKeys.fromSignature(await signDerivationMessage(signer, message));
  return { elgamalKeypair: keys.elgamal(), aesKey: keys.ae() };
}

/**
 * Derive the wallet's confidential-balances keys: the standard derivation.
 *
 * One signature over `solana-conf-bal/v1` yields both keys. Use this unless you
 * have a specific reason not to — it is what every other standard client
 * derives for the same wallet, so an account configured here can also be read
 * by the spl-token CLI and by wallets that implement the standard.
 */
export async function deriveConfidentialKeys(input: {
  signer: MessagePartialSigner;
}): Promise<ConfidentialKeypairs> {
  return confidentialKeysFrom(input.signer, ConfidentialKeys.signerMessage());
}

/**
 * Derive seed-scoped confidential-balances keys: a non-standard derivation.
 *
 * The signed message becomes `solana-conf-bal/v1 || publicSeed`. Keys derived
 * from a non-empty seed will NOT match the standard keys other clients derive
 * for the same wallet, so use this only for schemes that genuinely need keys
 * scoped more finely than the wallet — single-signer PDA wallets (pass
 * {@link pdaWalletPublicSeed}) or custom application keying.
 */
export async function deriveConfidentialKeysWithSeed(input: {
  signer: MessagePartialSigner;
  publicSeed: ReadonlyUint8Array;
}): Promise<ConfidentialKeypairs> {
  return confidentialKeysFrom(
    input.signer,
    ConfidentialKeys.signerMessageWithSeed(new Uint8Array(input.publicSeed)),
  );
}

/**
 * The canonical `publicSeed` for a single-signer PDA wallet, as
 * `programId || walletPda || mint || tokenAccount`. Pass the result to
 * {@link deriveConfidentialKeysWithSeed} so PDA wallets use one seed
 * convention across implementations.
 */
export function pdaWalletPublicSeed(input: {
  programId: Address;
  walletPda: Address;
  mint: Address;
  tokenAccount: Address;
}): Uint8Array {
  const encode = (address: Address) => new Uint8Array(getAddressEncoder().encode(address));
  return ConfidentialKeys.pdaWalletPublicSeed(
    encode(input.programId),
    encode(input.walletPda),
    encode(input.mint),
    encode(input.tokenAccount),
  );
}

/** An ElGamal public key as an Address, ready for a mint or account config. */
export function getElGamalPubkeyAddress(keypair: ElGamalKeypair): Address {
  return getAddressDecoder().decode(new Uint8Array(keypair.pubkey().toBytes()));
}

/**
 * The ElGamal half of the standard derivation, with the secret key as raw
 * bytes. Prefer {@link deriveConfidentialKeys} when you need both keys: it
 * asks the wallet for one signature instead of two.
 */
export async function deriveElGamalKeypair(input: {
  signer: MessagePartialSigner;
}): Promise<DerivedElGamalKeypair> {
  const { elgamalKeypair } = await deriveConfidentialKeys(input);
  return {
    elgamalPubkey: getElGamalPubkeyAddress(elgamalKeypair),
    secretKey: new Uint8Array(elgamalKeypair.secret().toBytes()),
  };
}

/**
 * The AES half of the standard derivation, as raw bytes. Prefer
 * {@link deriveConfidentialKeys} when you need both keys.
 */
export async function deriveAeKey(input: { signer: MessagePartialSigner }): Promise<Uint8Array> {
  const { aesKey } = await deriveConfidentialKeys(input);
  return new Uint8Array(aesKey.toBytes());
}
