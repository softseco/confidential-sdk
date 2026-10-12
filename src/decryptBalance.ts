// SPDX-License-Identifier: Apache-2.0
//
// decryptBalance(): decrypt the owner's confidential AVAILABLE balance using the
// AES key derived from the owner's wallet signer (or the `keys` passed in).
// Read-only — no transaction.
import {
  isSome,
  type Address,
  type MessageSigner,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
} from "@solana-program/token-2022";
import { AeCiphertext } from "./internal/zk";

import type { ConfidentialKeypairs } from "./keys";
import { assertKeysMatchAccount, ownerKeys } from "./internal/ownerKeys";

export type DecryptBalanceInput = {
  /** RPC client, e.g. `createSolanaRpc(url)`. */
  rpc: Rpc<SolanaRpcApi>;
  /**
   * Owner of the account. Signs the key-derivation message unless `keys` is given; nothing else
   * is signed.
   */
  owner: TransactionSigner | MessageSigner;
  mint: Address;
  /** Token account (defaults to the owner's ATA). */
  token?: Address;
  /** The owner's keys from {@link deriveConfidentialKeys}; skips the message signature. */
  keys?: ConfidentialKeypairs;
  /** Token program. Default: Token-2022. */
  programAddress?: Address;
};

/**
 * The owner's confidential available balance in base units, decrypted locally. Sends no
 * transaction. Amounts still pending are not included until {@link applyPendingBalance}.
 */
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

  const { data } = await fetchToken(input.rpc, token);
  if (!isSome(data.extensions)) {
    throw new Error("token account is not configured for confidential transfers");
  }
  const ct = data.extensions.value.find((e) => e.__kind === "ConfidentialTransferAccount");
  if (!ct) {
    throw new Error("token account is missing the ConfidentialTransferAccount extension");
  }

  const keys = await ownerKeys(input.owner, input.keys, "decryptBalance");
  assertKeysMatchAccount(keys, data, token, "decryptBalance");
  const { aesKey } = keys;

  const ciphertext = AeCiphertext.fromBytes(new Uint8Array(ct.decryptableAvailableBalance as Uint8Array));
  if (!ciphertext) {
    throw new Error("failed to parse the decryptable available balance");
  }
  return aesKey.decrypt(ciphertext);
}
