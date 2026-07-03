// SPDX-License-Identifier: Apache-2.0
//
// Auditor-key selective disclosure.
//
// A Token-2022 mint can designate an auditor ElGamal public key. When set, every
// confidential transfer on that mint additionally encrypts the transferred amount
// to the auditor. The auditor — and only the auditor — can then recover those
// amounts with its ElGamal secret key, without being able to spend or affecting
// the confidentiality of balances for anyone else. This is the "selective
// disclosure" pattern: privacy by default, auditability by designation.
import {
  createSignableMessage,
  getAddressDecoder,
  getBase58Encoder,
  type Address,
  type MessagePartialSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getConfidentialTransferInstructionDataDecoder,
} from "@solana-program/token-2022";
import { ElGamalCiphertext, ElGamalKeypair } from "@solana/zk-sdk/node";

const TRANSFER_AMOUNT_LO_BIT_LENGTH = 16n;

// A Token-2022 confidential-transfer instruction's data begins with the extension
// discriminator (27) followed by the inner ConfidentialTransfer discriminator (7).
const CONFIDENTIAL_TRANSFER_DISCRIMINATOR = 27;
const CONFIDENTIAL_TRANSFER_INNER_DISCRIMINATOR = 7;

/**
 * Derive the auditor's ElGamal keypair from its wallet signer. The key is
 * mint-independent (one auditor identity can audit any mint that designates it),
 * so it is recoverable from the wallet alone and never needs to be stored.
 */
export async function deriveAuditorElgamalKeypair(
  signer: MessagePartialSigner,
): Promise<ElGamalKeypair> {
  const message = ElGamalKeypair.signerMessage(new Uint8Array(0));
  const [signatures] = await signer.signMessages([createSignableMessage(message)]);
  const signature = signatures?.[signer.address];
  if (signature == null) {
    throw new Error(`Signer ${signer.address} did not return a signature`);
  }
  return ElGamalKeypair.fromSignature(new Uint8Array(signature));
}

/** The auditor's ElGamal public key as an Address, for a mint's confidential-transfer config. */
export function getAuditorElgamalPubkey(auditorKeypair: ElGamalKeypair): Address {
  return getAddressDecoder().decode(new Uint8Array(auditorKeypair.pubkey().toBytes()));
}

export type DecryptTransferAmountAsAuditorInput = {
  rpc: Rpc<SolanaRpcApi>;
  /** Signature of a confirmed transaction containing the confidential transfer. */
  signature: Signature;
  auditorKeypair: ElGamalKeypair;
  programAddress?: Address;
};

type FetchedTransactionMessage = {
  transaction: {
    message: {
      accountKeys?: readonly string[];
      staticAccountKeys?: readonly string[];
      instructions: ReadonlyArray<{ programIdIndex: number; data: string }>;
    };
  };
};

/**
 * Recover the amount of a confidential transfer as the mint's auditor: decode the
 * confidential-transfer instruction from the confirmed transaction and decrypt the
 * auditor ciphertext (lo/hi halves) with the auditor's ElGamal secret key.
 */
export async function decryptTransferAmountAsAuditor(
  input: DecryptTransferAmountAsAuditorInput,
): Promise<bigint> {
  const programAddress = input.programAddress ?? TOKEN_2022_PROGRAM_ADDRESS;
  const result = await input.rpc
    .getTransaction(input.signature, {
      commitment: "confirmed",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  if (result == null) {
    throw new Error("transaction not found");
  }

  const message = (result as unknown as FetchedTransactionMessage).transaction.message;
  const accountKeys = message.accountKeys ?? message.staticAccountKeys ?? [];
  const base58 = getBase58Encoder();
  const secret = input.auditorKeypair.secret();

  for (const instruction of message.instructions) {
    if (accountKeys[instruction.programIdIndex] !== programAddress) continue;
    const data = new Uint8Array(base58.encode(instruction.data));
    if (
      data[0] !== CONFIDENTIAL_TRANSFER_DISCRIMINATOR ||
      data[1] !== CONFIDENTIAL_TRANSFER_INNER_DISCRIMINATOR
    ) {
      continue;
    }

    const decoded = getConfidentialTransferInstructionDataDecoder().decode(data);
    const lo = ElGamalCiphertext.fromBytes(new Uint8Array(decoded.transferAmountAuditorCiphertextLo));
    const hi = ElGamalCiphertext.fromBytes(new Uint8Array(decoded.transferAmountAuditorCiphertextHi));
    if (!lo || !hi) {
      throw new Error("failed to parse the auditor ciphertext");
    }
    return secret.decrypt(lo) + (secret.decrypt(hi) << TRANSFER_AMOUNT_LO_BIT_LENGTH);
  }

  throw new Error("no confidential-transfer instruction found in this transaction");
}
