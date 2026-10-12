// SPDX-License-Identifier: Apache-2.0
//
// transfer(): confidentially move tokens from the owner's AVAILABLE balance to a
// destination account. This generates the three required zero-knowledge proofs
// (ciphertext-commitment equality, batched grouped-ciphertext validity, and
// batched range), verifies each into a dedicated context-state account, runs the
// transfer that references those accounts, and finally closes them. The
// transactions are signed together (one wallet prompt) and sent in order; if a
// step fails before the transfer lands, the proof accounts are closed again
// (see internal/send.ts).
import {
  type Address,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token-2022";

import { ConfidentialTransfersError } from "./errors";
import { assertCanReceive, readConfiguredAccount } from "./internal/accounts";
import { getConfidentialTransferProofFlow } from "./internal/confidentialTransferProof";
import { assertKeysMatchAccount, ownerKeys } from "./internal/ownerKeys";
import { executeProofFlow, withRetries, type SendOptions } from "./internal/send";
import { resolveTransferHookAccounts } from "./internal/transferHook";
import type { ConfidentialKeypairs } from "./keys";

export type TransferInput = SendOptions & {
  /** RPC client, e.g. `createSolanaRpc(url)`. */
  rpc: Rpc<SolanaRpcApi>;
  /** Used to confirm the transaction(s). */
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** Pays the transaction fees and the rent of the proof accounts (refunded when they close). */
  payer: TransactionSigner;
  /**
   * Source account owner: the transfer authority, and the key source unless `keys` is given.
   */
  owner: TransactionSigner;
  mint: Address;
  /** Owner of the destination account; used to derive its ATA when no token is given. */
  destinationOwner?: Address;
  /** Amount in base units. Up to 2^48 - 1 per transfer. */
  amount: bigint;
  /** Source token account (defaults to the owner's ATA). */
  sourceToken?: Address;
  /** Destination token account; must be configured for confidential transfers. */
  destinationToken?: Address;
  /** The mint's auditor ElGamal key, when the mint has one; the amount is also encrypted to it. */
  auditorElgamalPubkey?: Address;
  /** The owner's keys from {@link deriveConfidentialKeys}; skips the message signature. */
  keys?: ConfidentialKeypairs;
  /** Token program. Default: Token-2022. */
  programAddress?: Address;
};

export type TransferResult = {
  sourceToken: Address;
  destinationToken: Address;
  /** The transactions sent, in order. */
  signatures: Signature[];
  /**
   * Proof accounts left open although the transfer went through (only if closing them failed;
   * normally empty). `recoverProofAccounts` closes them.
   */
  proofAccountsLeftOpen: Address[];
};

/**
 * Send a confidential amount from the owner's available balance to another account. Builds the
 * three zero-knowledge proofs, verifies them into proof accounts, runs the transfer (with the
 * mint's transfer-hook accounts, if it has a hook) and closes the proof accounts: five
 * transactions, signed together (a wallet asks once) and sent in order. If a step fails before
 * the transfer itself lands, the proof accounts are closed and a ConfidentialTransfersError says
 * which step failed.
 *
 * @example
 * ```ts
 * await transfer({ rpc, rpcSubscriptions, payer, owner: alice, mint, destinationOwner: bob.address, amount: 600n });
 * ```
 */
export async function transfer(input: TransferInput): Promise<TransferResult> {
  const operation = "transfer";
  const programAddress = input.programAddress ?? TOKEN_2022_PROGRAM_ADDRESS;
  const amount = BigInt(input.amount);
  if (amount <= 0n) {
    throw new ConfidentialTransfersError("INVALID_INPUT", `${operation}: the amount must be greater than zero, got ${amount}.`, { operation });
  }

  const sourceToken =
    input.sourceToken ??
    (await findAssociatedTokenPda({ owner: input.owner.address, tokenProgram: programAddress, mint: input.mint }))[0];

  let destinationToken = input.destinationToken;
  if (destinationToken == null) {
    if (input.destinationOwner == null) {
      throw new ConfidentialTransfersError("INVALID_INPUT", "transfer requires either destinationToken or destinationOwner", { operation });
    }
    destinationToken = (
      await findAssociatedTokenPda({ owner: input.destinationOwner, tokenProgram: programAddress, mint: input.mint })
    )[0];
  }
  const destination = destinationToken;

  let keys = input.keys;
  const result = await withRetries(input.retries, async () => {
    const [source, dest] = await Promise.all([
      readConfiguredAccount(input.rpc, sourceToken, operation, "your"),
      readConfiguredAccount(input.rpc, destination, operation, "the recipient's"),
    ]);
    assertCanReceive(dest.ct, destination, operation, "the recipient's");

    // Token-2022 calls the mint's transfer hook on a confidential transfer too, and the hook's
    // accounts have to travel with the instruction or the transfer fails with MissingAccount.
    const transferHookAccounts = await resolveTransferHookAccounts({
      rpc: input.rpc,
      mint: input.mint,
      sourceToken,
      destinationToken: destination,
      owner: input.owner.address,
      programAddress,
    });

    keys ??= await ownerKeys(input.owner, undefined, operation);
    assertKeysMatchAccount(keys, source.data, sourceToken, operation);

    const flow = await getConfidentialTransferProofFlow({
      payer: input.payer,
      rpc: input.rpc,
      sourceToken,
      mint: input.mint,
      destinationToken: destination,
      sourceTokenAccount: source.data,
      destinationTokenAccount: dest.data,
      authority: input.owner,
      amount,
      sourceElgamalKeypair: keys.elgamalKeypair,
      aesKey: keys.aesKey,
      auditorElgamalPubkey: input.auditorElgamalPubkey,
      transferHookAccounts,
      programAddress,
    });
    return executeProofFlow(
      { rpc: input.rpc, rpcSubscriptions: input.rpcSubscriptions, payer: input.payer, operation, computeUnitPrice: input.computeUnitPrice },
      flow,
      operation,
    );
  });

  return { sourceToken, destinationToken: destination, ...result };
}
