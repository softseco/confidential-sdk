// SPDX-License-Identifier: Apache-2.0
//
// withdraw(): move tokens from the owner's confidential AVAILABLE balance back to
// the public balance of the same account. The withdrawn amount is public (it is
// an instruction argument); the balance that remains stays encrypted. Two
// zero-knowledge proofs are required (ciphertext-commitment equality and a range
// proof on the remaining balance). Each is verified into a context-state account,
// the withdraw runs, and the proof accounts are closed. Apply the pending balance
// first: only the available balance can be withdrawn.
import {
  type Address,
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
} from "@solana-program/token-2022";
import type { ConfidentialKeypairs } from "./keys";
import { assertKeysMatchAccount, ownerKeys } from "./internal/ownerKeys";
import { getConfidentialWithdrawInstructionPlan } from "./internal/confidentialTransferProof";
import { executeInstructionPlan } from "./internal/executePlan";

export type WithdrawInput = {
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
  signatures: Signature[];
};

/**
 * Move tokens from the confidential available balance back to the public balance of the same
 * account. The withdrawn amount is public; the remaining balance stays encrypted. Builds two
 * proofs, verifies them into proof accounts, withdraws and closes the proof accounts.
 */
export async function withdraw(input: WithdrawInput): Promise<WithdrawResult> {
  const programAddress = input.programAddress ?? TOKEN_2022_PROGRAM_ADDRESS;
  const amount = BigInt(input.amount);
  if (amount <= 0n) {
    throw new Error(`withdraw amount must be greater than zero, got ${amount}`);
  }

  const token =
    input.token ??
    (
      await findAssociatedTokenPda({
        owner: input.owner.address,
        tokenProgram: programAddress,
        mint: input.mint,
      })
    )[0];

  const { data: tokenAccount } = await fetchToken(input.rpc, token);
  const keys = await ownerKeys(input.owner, input.keys, "withdraw");
  assertKeysMatchAccount(keys, tokenAccount, token, "withdraw");
  const { elgamalKeypair, aesKey } = keys;

  const instructionPlan = await getConfidentialWithdrawInstructionPlan({
    payer: input.payer,
    rpc: input.rpc,
    token,
    mint: input.mint,
    tokenAccount,
    authority: input.owner,
    amount,
    decimals: input.decimals,
    elgamalKeypair,
    aesKey,
    programAddress,
  });

  const signatures = await executeInstructionPlan({
    rpc: input.rpc,
    rpcSubscriptions: input.rpcSubscriptions,
    payer: input.payer,
    instructionPlan,
    label: "confidential withdraw",
  });

  return { token, signatures };
}
