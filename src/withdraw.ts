// SPDX-License-Identifier: Apache-2.0
//
// withdraw(): move tokens from the owner's confidential AVAILABLE balance back to
// the public balance of the same account. The withdrawn amount is public (it is
// an instruction argument); the balance that remains stays encrypted. Two
// zero-knowledge proofs are required (ciphertext-commitment equality and a range
// proof on the remaining balance). Each is verified into a context-state account,
// the withdraw runs, and the proof accounts are closed. The transactions are
// signed together and sent in order (see internal/send.ts). Apply the pending
// balance first: only the available balance can be withdrawn.
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
import { readConfiguredAccount } from "./internal/accounts";
import { getConfidentialWithdrawProofFlow } from "./internal/confidentialTransferProof";
import { assertKeysMatchAccount, ownerKeys } from "./internal/ownerKeys";
import { executeProofFlow, withRetries, type SendOptions } from "./internal/send";
import type { ConfidentialKeypairs } from "./keys";

export type WithdrawInput = SendOptions & {
  /** RPC client, e.g. `createSolanaRpc(url)`. */
  rpc: Rpc<SolanaRpcApi>;
  /** Used to confirm the transaction(s). */
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** Pays the transaction fees and the rent of the proof accounts (refunded when they close). */
  payer: TransactionSigner;
  /** Owner of the token account: the withdraw authority, and the key source unless `keys` is given. */
  owner: TransactionSigner;
  /** Mint configured for confidential transfers. */
  mint: Address;
  /** Amount (base units) to move from the confidential available balance to the public balance. */
  amount: number | bigint;
  /** Mint decimals (must match the mint). */
  decimals: number;
  /** Token account to withdraw from (defaults to the owner's ATA). */
  token?: Address;
  /** The owner's keys from {@link deriveConfidentialKeys}; skips the message signature. */
  keys?: ConfidentialKeypairs;
  /** Token program. Default: Token-2022. */
  programAddress?: Address;
};

export type WithdrawResult = {
  token: Address;
  /** The transactions sent, in order. */
  signatures: Signature[];
  /** Proof accounts left open although the withdraw went through (normally empty). */
  proofAccountsLeftOpen: Address[];
};

/**
 * Move tokens from the confidential available balance back to the public balance of the same
 * account. The withdrawn amount is public; the remaining balance stays encrypted. Builds two
 * proofs, verifies them into proof accounts, withdraws and closes the proof accounts: four
 * transactions, signed together and sent in order.
 */
export async function withdraw(input: WithdrawInput): Promise<WithdrawResult> {
  const operation = "withdraw";
  const programAddress = input.programAddress ?? TOKEN_2022_PROGRAM_ADDRESS;
  const amount = BigInt(input.amount);
  if (amount <= 0n) {
    throw new ConfidentialTransfersError("INVALID_INPUT", `withdraw amount must be greater than zero, got ${amount}`, { operation });
  }

  const token =
    input.token ??
    (await findAssociatedTokenPda({ owner: input.owner.address, tokenProgram: programAddress, mint: input.mint }))[0];

  let keys = input.keys;
  const result = await withRetries(input.retries, async () => {
    const { data } = await readConfiguredAccount(input.rpc, token, operation, "your");
    keys ??= await ownerKeys(input.owner, undefined, operation);
    assertKeysMatchAccount(keys, data, token, operation);

    const flow = await getConfidentialWithdrawProofFlow({
      payer: input.payer,
      rpc: input.rpc,
      token,
      mint: input.mint,
      tokenAccount: data,
      authority: input.owner,
      amount,
      decimals: input.decimals,
      elgamalKeypair: keys.elgamalKeypair,
      aesKey: keys.aesKey,
      programAddress,
    });
    return executeProofFlow(
      { rpc: input.rpc, rpcSubscriptions: input.rpcSubscriptions, payer: input.payer, operation, computeUnitPrice: input.computeUnitPrice },
      flow,
      operation,
    );
  });

  return { token, ...result };
}
