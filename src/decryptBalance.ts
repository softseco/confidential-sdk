// SPDX-License-Identifier: Apache-2.0
//
// decryptBalance(): decrypt the owner's confidential AVAILABLE balance using the
// AES key derived from the owner's wallet signer (or the `keys` passed in).
// Read-only — no transaction.
import {
  type Address,
  type MessageSigner,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token-2022";

import { ConfidentialTransfersError } from "./errors";
import { readConfiguredAccount } from "./internal/accounts";
import { assertKeysMatchAccount, ownerKeys } from "./internal/ownerKeys";
import { AeCiphertext } from "./internal/zk";
import type { ConfidentialKeypairs } from "./keys";

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

  const operation = "decryptBalance";
  const { data, ct } = await readConfiguredAccount(input.rpc, token, operation);

  const keys = await ownerKeys(input.owner, input.keys, operation);
  assertKeysMatchAccount(keys, data, token, operation);

  const ciphertext = AeCiphertext.fromBytes(new Uint8Array(ct.decryptableAvailableBalance as Uint8Array));
  if (!ciphertext) {
    throw new ConfidentialTransfersError("DECRYPTION_FAILED", `${operation}: failed to parse the decryptable available balance`, { operation });
  }
  try {
    return keys.aesKey.decrypt(ciphertext);
  } catch (e) {
    throw new ConfidentialTransfersError("DECRYPTION_FAILED", `${operation}: could not decrypt the available balance of ${token}: ${String(e)}`, { operation, cause: e });
  }
}
