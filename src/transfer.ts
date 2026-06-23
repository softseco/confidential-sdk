// SPDX-License-Identifier: Apache-2.0
//
// transfer(): confidentially move tokens from the owner's AVAILABLE balance to a
// destination account. This generates the three required zero-knowledge proofs
// (ciphertext-commitment equality, batched grouped-ciphertext validity, and
// batched range), verifies each into a dedicated context-state account, runs the
// transfer that references those accounts, and finally closes them. The whole
// flow is produced as an InstructionPlan by the canonical SPL helper and executed
// here as a sequence of transactions.
import {
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  createTransactionPlanExecutor,
  createTransactionPlanner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
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
import { deriveConfidentialKeypairs } from "./keys";
import { getConfidentialTransferInstructionPlan } from "./internal/confidentialTransferProof";

const bigintReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

/** Recursively find the first failed leaf in a transaction-plan result tree. */
function findFailedStep(node: unknown): { error?: unknown } | undefined {
  if (node == null || typeof node !== "object") return undefined;
  const n = node as Record<string, unknown>;
  if (n.kind === "single") {
    return n.status === "failed" ? (n as { error?: unknown }) : undefined;
  }
  for (const value of Object.values(n)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findFailedStep(child);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      const found = findFailedStep(value);
      if (found) return found;
    }
  }
  return undefined;
}

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

  const { elgamalKeypair, aesKey } = await deriveConfidentialKeypairs({
    signer: input.owner,
    owner: input.owner.address,
    mint: input.mint,
  });

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
    programAddress,
  });

  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(createTransactionMessage({ version: 0 }), (tx) =>
        setTransactionMessageFeePayerSigner(input.payer, tx),
      ),
  });
  const transactionPlan = await planner(instructionPlan);

  const send = sendAndConfirmTransactionFactory({
    rpc: input.rpc,
    rpcSubscriptions: input.rpcSubscriptions,
  });
  const signatures: Signature[] = [];

  const executor = createTransactionPlanExecutor({
    executeTransactionMessage: async (_context, message) => {
      const { value: latestBlockhash } = await input.rpc.getLatestBlockhash().send();
      const signed = await signTransactionMessageWithSigners(
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
      );

      const simulation = await input.rpc
        .simulateTransaction(getBase64EncodedWireTransaction(signed), {
          encoding: "base64",
          replaceRecentBlockhash: true,
          sigVerify: false,
        })
        .send();
      if (simulation.value.err) {
        throw new Error(
          "confidential transfer step failed simulation: " +
            JSON.stringify(simulation.value.err, bigintReplacer) +
            "\n--- program logs ---\n" +
            (simulation.value.logs ?? []).join("\n"),
        );
      }

      assertIsTransactionWithBlockhashLifetime(signed);
      await send(signed, { commitment: "confirmed", skipPreflight: true });
      const signature = getSignatureFromTransaction(signed);
      signatures.push(signature);
      return signature;
    },
  });

  let result: Awaited<ReturnType<typeof executor>>;
  try {
    result = await executor(transactionPlan);
  } catch (e) {
    const wrapped = e as { context?: { transactionPlanResult?: unknown }; cause?: unknown };
    const failed =
      findFailedStep(wrapped?.context?.transactionPlanResult) ?? findFailedStep(wrapped?.cause);
    if (failed?.error instanceof Error) throw failed.error;
    throw e;
  }
  const failed = findFailedStep(result);
  if (failed) {
    throw failed.error instanceof Error
      ? failed.error
      : new Error("confidential transfer failed: " + JSON.stringify(failed.error, bigintReplacer));
  }

  return { sourceToken, destinationToken, signatures };
}
