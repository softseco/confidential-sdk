// SPDX-License-Identifier: Apache-2.0
//
// Plans an InstructionPlan into transactions and sends them one by one. Every
// transaction is simulated first so that a failing step surfaces its program
// logs instead of a bare error code. Shared by transfer() and withdraw().
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
  type InstructionPlan,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from "@solana/kit";

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

export type ExecuteInstructionPlanInput = {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  payer: TransactionSigner;
  instructionPlan: InstructionPlan;
  /** Used in error messages, e.g. "confidential transfer". */
  label: string;
};

/** Sends every transaction of the plan in order and returns their signatures. */
export async function executeInstructionPlan(
  input: ExecuteInstructionPlanInput,
): Promise<Signature[]> {
  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(createTransactionMessage({ version: 0 }), (tx) =>
        setTransactionMessageFeePayerSigner(input.payer, tx),
      ),
  });
  const transactionPlan = await planner(input.instructionPlan);

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
          `${input.label} step failed simulation: ` +
            JSON.stringify(simulation.value.err, bigintReplacer) +
            "\n--- program logs ---\n" +
            (simulation.value.logs ?? []).join("\n"),
        );
      }

      assertIsTransactionWithBlockhashLifetime(signed);
      await send(signed, { commitment: "confirmed", skipPreflight: true });
      const signature = getSignatureFromTransaction(signed);
      signatures.push(signature);
      return { signature };
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
      : new Error(`${input.label} failed: ` + JSON.stringify(failed.error, bigintReplacer));
  }
  return signatures;
}
