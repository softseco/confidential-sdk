// SPDX-License-Identifier: Apache-2.0
//
// transfer(): confidentially move tokens from the owner's AVAILABLE balance to a
// destination account. This generates the three required zero-knowledge proofs
// (ciphertext-commitment equality, batched grouped-ciphertext validity, and
// batched range), verifies each into a dedicated context-state account, runs the
// transfer that references those accounts, and finally closes them. The whole
// flow is produced as an InstructionPlan by the canonical SPL helper and executed
// as a sequence of transactions (see internal/executePlan.ts).
import {
  type Address,
  type MessagePartialSigner,
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
import { deriveConfidentialKeys } from "./keys";
import { getConfidentialTransferInstructionPlan } from "./internal/confidentialTransferProof";
import { executeInstructionPlan } from "./internal/executePlan";
import { resolveTransferHookAccounts } from "./internal/transferHook";

export type TransferInput = {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  payer: TransactionSigner;
  /** Source account owner — also the transfer authority and the key source. */
  owner: TransactionSigner & MessagePartialSigner;
  mint: Address;
  /** Owner of the destination account; used to derive its ATA when no token is given. */
  destinationOwner?: Address;
  amount: bigint;
  sourceToken?: Address;
  destinationToken?: Address;
  auditorElgamalPubkey?: Address;
  programAddress?: Address;
};

export type TransferResult = {
  sourceToken: Address;
  destinationToken: Address;
  signatures: Signature[];
};

export async function transfer(input: TransferInput): Promise<TransferResult> {
  const programAddress = input.programAddress ?? TOKEN_2022_PROGRAM_ADDRESS;

  const sourceToken =
    input.sourceToken ??
    (
      await findAssociatedTokenPda({
        owner: input.owner.address,
        tokenProgram: programAddress,
        mint: input.mint,
      })
    )[0];

  let destinationToken = input.destinationToken;
  if (destinationToken == null) {
    if (input.destinationOwner == null) {
      throw new Error("transfer requires either destinationToken or destinationOwner");
    }
    destinationToken = (
      await findAssociatedTokenPda({
        owner: input.destinationOwner,
        tokenProgram: programAddress,
        mint: input.mint,
      })
    )[0];
  }

  // Token-2022 calls the mint's transfer hook on a confidential transfer too, and the hook's
  // accounts have to travel with the instruction or the transfer fails with MissingAccount.
  const transferHookAccounts = await resolveTransferHookAccounts({
    rpc: input.rpc,
    mint: input.mint,
    sourceToken,
    destinationToken,
    owner: input.owner.address,
    programAddress,
  });

  const { elgamalKeypair, aesKey } = await deriveConfidentialKeys({ signer: input.owner });

  const [{ data: sourceTokenAccount }, { data: destinationTokenAccount }] = await Promise.all([
    fetchToken(input.rpc, sourceToken),
    fetchToken(input.rpc, destinationToken),
  ]);

  const instructionPlan = await getConfidentialTransferInstructionPlan({
    payer: input.payer,
    rpc: input.rpc,
    sourceToken,
    mint: input.mint,
    destinationToken,
    sourceTokenAccount,
    destinationTokenAccount,
    authority: input.owner,
    amount: input.amount,
    sourceElgamalKeypair: elgamalKeypair,
    aesKey,
    auditorElgamalPubkey: input.auditorElgamalPubkey,
    transferHookAccounts,
    programAddress,
  });

  const signatures = await executeInstructionPlan({
    rpc: input.rpc,
    rpcSubscriptions: input.rpcSubscriptions,
    payer: input.payer,
    instructionPlan,
    label: "confidential transfer",
  });

  return { sourceToken, destinationToken, signatures };
}
