// SPDX-License-Identifier: Apache-2.0
//
// applyPendingBalance(): move an account's confidential PENDING balance into its
// AVAILABLE balance. The pending balance (ElGamal-encrypted) is decrypted locally
// with the owner's ElGamal secret key, added to the current available balance,
// and the new available balance is re-encrypted (AES) into the account's
// decryptable balance. Keys are derived from the owner's wallet signer, or passed
// in as `keys`.
import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSome,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type ReadonlyUint8Array,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from "@solana/kit";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getApplyConfidentialPendingBalanceInstruction,
} from "@solana-program/token-2022";
import { AeCiphertext, ElGamalCiphertext } from "./internal/zk";

import type { ConfidentialKeypairs } from "./keys";
import { assertKeysMatchAccount, ownerKeys } from "./internal/ownerKeys";

const PENDING_BALANCE_LO_BIT_LENGTH = 16n;

export type ApplyPendingBalanceInput = {
  /** RPC client, e.g. `createSolanaRpc(url)`. */
  rpc: Rpc<SolanaRpcApi>;
  /** Used to confirm the transaction(s). */
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** Pays the transaction fee. */
  payer: TransactionSigner;
  /** Signs the instruction, and the key-derivation message unless `keys` is given. */
  owner: TransactionSigner;
  mint: Address;
  /** Token account (defaults to the owner's ATA). */
  token?: Address;
  /** The owner's keys from {@link deriveConfidentialKeys}; skips the message signature. */
  keys?: ConfidentialKeypairs;
  /** Token program. Default: Token-2022. */
  programAddress?: Address;
};

export type ApplyPendingBalanceResult = { token: Address; signature: Signature };

/**
 * Move the incoming (pending) confidential balance into the available balance, which can be
 * transferred or withdrawn. Decrypts the pending amounts locally and writes the new available
 * balance, encrypted, in one transaction.
 */
export async function applyPendingBalance(
  input: ApplyPendingBalanceInput,
): Promise<ApplyPendingBalanceResult> {
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

  const keys = await ownerKeys(input.owner, input.keys, "applyPendingBalance");
  assertKeysMatchAccount(keys, data, token, "applyPendingBalance");
  const { elgamalKeypair, aesKey } = keys;
  const elgamalSecretKey = elgamalKeypair.secret();

  const parseElGamal = (bytes: ReadonlyUint8Array) => {
    const c = ElGamalCiphertext.fromBytes(new Uint8Array(bytes as Uint8Array));
    if (!c) throw new Error("failed to parse an ElGamal ciphertext");
    return c;
  };
  const parseAe = (bytes: ReadonlyUint8Array) => {
    const c = AeCiphertext.fromBytes(new Uint8Array(bytes as Uint8Array));
    if (!c) throw new Error("failed to parse an AES ciphertext");
    return c;
  };

  const pendingLo = elgamalSecretKey.decrypt(parseElGamal(ct.pendingBalanceLow));
  const pendingHi = elgamalSecretKey.decrypt(parseElGamal(ct.pendingBalanceHigh));
  const currentAvailable = aesKey.decrypt(parseAe(ct.decryptableAvailableBalance));
  const newAvailable = currentAvailable + ((pendingHi << PENDING_BALANCE_LO_BIT_LENGTH) + pendingLo);
  const newDecryptableAvailableBalance = aesKey.encrypt(newAvailable).toBytes();

  const instruction = getApplyConfidentialPendingBalanceInstruction(
    {
      token,
      authority: input.owner,
      expectedPendingBalanceCreditCounter: ct.pendingBalanceCreditCounter,
      newDecryptableAvailableBalance,
    },
    { programAddress },
  );

  const { value: latestBlockhash } = await input.rpc.getLatestBlockhash().send();
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(input.payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions([instruction], tx),
  );
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);

  const simulation = await input.rpc
    .simulateTransaction(getBase64EncodedWireTransaction(signedTransaction), {
      encoding: "base64",
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (simulation.value.err) {
    throw new Error(
      "applyPendingBalance transaction failed simulation: " +
        JSON.stringify(simulation.value.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) +
        "\n--- program logs ---\n" +
        (simulation.value.logs ?? []).join("\n"),
    );
  }

  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  await sendAndConfirmTransactionFactory({
    rpc: input.rpc,
    rpcSubscriptions: input.rpcSubscriptions,
  })(signedTransaction, { commitment: "confirmed", skipPreflight: true });

  return { token, signature: getSignatureFromTransaction(signedTransaction) };
}
