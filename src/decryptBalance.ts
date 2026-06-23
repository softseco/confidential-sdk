// SPDX-License-Identifier: Apache-2.0
//
// decryptBalance(): decrypt the owner's confidential AVAILABLE balance using the
// AES key derived from the owner's wallet signer. Read-only — no transaction.
import {
  isSome,
  type Address,
  type MessagePartialSigner,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
} from "@solana-program/token-2022";
import { AeCiphertext } from "@solana/zk-sdk/node";

import { deriveConfidentialKeypairs } from "./keys";

export type DecryptBalanceInput = {
  rpc: Rpc<SolanaRpcApi>;
  /** Owner of the account, used to derive the viewing (AES) key. */
  owner: TransactionSigner & MessagePartialSigner;
  mint: Address;
  token?: Address;
  programAddress?: Address;
};

/** Returns the decrypted confidential available balance (base units). */
export async function decryptBalance(input: DecryptBalanceInput): Promise<bigint> {
  const programAddress = input.programAddress ?? TOKEN_2022_PROGRAM_ADDRESS;
  const token =
    input.token ??
    (
      await findAssociatedTokenPda({
        owner: input.owner.address,
        tokenProgram: programAddress,
        mint: input.mint,
      })
    )[0];

  const { aesKey } = await deriveConfidentialKeypairs({
    signer: input.owner,
    owner: input.owner.address,
    mint: input.mint,
  });

  const { data } = await fetchToken(input.rpc, token);
  if (!isSome(data.extensions)) {
    throw new Error("token account is not configured for confidential transfers");
  }
  const ct = data.extensions.value.find((e) => e.__kind === "ConfidentialTransferAccount");
  if (!ct) {
    throw new Error("token account is missing the ConfidentialTransferAccount extension");
  }

  const ciphertext = AeCiphertext.fromBytes(new Uint8Array(ct.decryptableAvailableBalance as Uint8Array));
  if (!ciphertext) {
    throw new Error("failed to parse the decryptable available balance");
  }
  return aesKey.decrypt(ciphertext);
}
