// SPDX-License-Identifier: Apache-2.0
//
// Sending transactions: one for configure, deposit and apply; several for transfer and withdraw.
//
// For a multi-transaction operation every transaction is planned and signed up front, in one call
// per signer, so a browser wallet asks once ("approve 5 transactions") instead of once per
// transaction. They are then sent in order, each simulated first so a failure comes with its
// program logs. If a step fails before the transfer or withdraw itself lands, the proof accounts
// created so far are closed again, which returns their rent to the payer.
import {
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  compileTransaction,
  createTransactionMessage,
  createTransactionPlanner,
  flattenTransactionPlan,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getSignersFromTransactionMessage,
  isSolanaError,
  isTransactionMessageWithinSizeLimit,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS, closeContextStateProof } from "@solana-program/zk-elgamal-proof";

import { ConfidentialTransfersError, isConfidentialTransfersError } from "../errors";
import { proofFlowToPlan, type ProofFlow } from "./confidentialTransferProof";

/** Options every sending function accepts. */
export type SendOptions = {
  /**
   * Priority fee, in micro-lamports per compute unit, added to each transaction that has room
   * for it. The range-proof transaction of a transfer is too full to take one and goes without.
   */
  computeUnitPrice?: bigint | number;
  /**
   * How many times to run the whole operation again when a transaction expires before it is
   * confirmed (`TRANSACTION_EXPIRED`). Each retry builds and signs new transactions, so a wallet
   * asks again. Default 0.
   */
  retries?: number;
};

export type SendContext = {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  payer: TransactionSigner;
  /** The SDK function, for error messages. */
  operation: string;
  computeUnitPrice?: bigint | number;
};

type Message = Parameters<typeof compileTransaction>[0];
type BlockhashLifetime = { blockhash: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]["blockhash"]; lastValidBlockHeight: bigint };
type SendableTransaction = Transaction & { lifetimeConstraint: BlockhashLifetime };

const bigintReplacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

function withPriorityFee<T extends Message>(message: T, price: bigint | number | undefined): T {
  if (price === undefined || BigInt(price) === 0n) return message;
  const priced = setTransactionMessageComputeUnitPrice(BigInt(price), message as never) as unknown as T;
  return isTransactionMessageWithinSizeLimit(priced as never) ? priced : message;
}

/**
 * Sign several transaction messages with their signers, asking each signer once for all the
 * transactions it has to sign. Follows kit's rules for which signer interface is used: modifying
 * signers (wallets) first, then partial signers (keypairs), so a wallet that changes a
 * transaction does so before anyone else signs it.
 */
export async function signTransactionMessagesTogether(
  messages: readonly Message[],
  lifetime: BlockhashLifetime,
): Promise<SendableTransaction[]> {
  let transactions: Transaction[] = messages.map((m) => compileTransaction(m));
  const signersByTx = messages.map((m) => getSignersFromTransactionMessage(m as never) as TransactionSigner[]);

  const unique = new Map<Address, TransactionSigner>();
  for (const signers of signersByTx) for (const s of signers) if (!unique.has(s.address)) unique.set(s.address, s);
  const candidates = [...unique.values()].filter((s) => isTransactionModifyingSigner(s) || isTransactionPartialSigner(s));
  const modifying = candidates.filter(isTransactionModifyingSigner);
  const modifyingOnly = modifying.filter((s) => !isTransactionPartialSigner(s));
  const modifyingSigners = modifyingOnly.length > 0 ? modifyingOnly : modifying.slice(0, 1);
  const chosen = new Set<TransactionSigner>(modifyingSigners);
  const partialSigners = candidates.filter((s) => isTransactionPartialSigner(s) && !chosen.has(s));

  const needs = (signer: TransactionSigner) =>
    transactions.map((_, i) => i).filter((i) => signersByTx[i].some((s) => s.address === signer.address));

  for (const signer of modifyingSigners) {
    if (!isTransactionModifyingSigner(signer)) continue;
    const indexes = needs(signer);
    if (indexes.length === 0) continue;
    const signed = await signer.modifyAndSignTransactions(indexes.map((i) => transactions[i]) as never);
    indexes.forEach((txIndex, k) => (transactions[txIndex] = signed[k] as Transaction));
  }
  await Promise.all(
    partialSigners.map(async (signer) => {
      if (!isTransactionPartialSigner(signer)) return;
      const indexes = needs(signer);
      if (indexes.length === 0) return;
      const dictionaries = await signer.signTransactions(indexes.map((i) => transactions[i]) as never);
      indexes.forEach((txIndex, k) => {
        const tx = transactions[txIndex];
        transactions[txIndex] = Object.freeze({ ...tx, signatures: Object.freeze({ ...tx.signatures, ...dictionaries[k] }) });
      });
    }),
  );
  return transactions.map((tx) => {
    assertIsFullySignedTransaction(tx);
    // A wallet that modifies a transaction may drop the lifetime kit uses to wait for it.
    const withLifetime = "lifetimeConstraint" in tx ? tx : { ...tx, lifetimeConstraint: lifetime };
    return withLifetime as SendableTransaction;
  });
}

async function logsOf(ctx: SendContext, signature: Signature): Promise<string[] | undefined> {
  try {
    const tx = await ctx.rpc
      .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" })
      .send();
    return tx?.meta?.logMessages ? [...tx.meta.logMessages] : undefined;
  } catch {
    return undefined;
  }
}

/** Simulate, then send and wait for confirmation. Throws ConfidentialTransfersError. */
async function simulateAndSend(ctx: SendContext, tx: SendableTransaction, step: string): Promise<Signature> {
  const simulation = await ctx.rpc
    .simulateTransaction(getBase64EncodedWireTransaction(tx), {
      encoding: "base64",
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (simulation.value.err) {
    const logs = simulation.value.logs ?? [];
    throw new ConfidentialTransfersError(
      "TRANSACTION_FAILED",
      `${ctx.operation} ${step === ctx.operation ? "transaction" : `step "${step}"`} failed simulation: ` +
        JSON.stringify(simulation.value.err, bigintReplacer) +
        "\n--- program logs ---\n" +
        logs.join("\n"),
      { operation: ctx.operation, step, logs },
    );
  }
  const signature = getSignatureFromTransaction(tx);
  try {
    await sendAndConfirmTransactionFactory({ rpc: ctx.rpc, rpcSubscriptions: ctx.rpcSubscriptions })(tx as never, {
      commitment: "confirmed",
      skipPreflight: true,
    });
  } catch (e) {
    if (isSolanaError(e, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED)) {
      throw new ConfidentialTransfersError(
        "TRANSACTION_EXPIRED",
        `${ctx.operation}: a transaction was not confirmed before its blockhash expired (the network may be busy; a priority fee helps). Nothing from it landed; it is safe to run again.`,
        { operation: ctx.operation, step, cause: e },
      );
    }
    throw new ConfidentialTransfersError(
      "TRANSACTION_FAILED",
      `${ctx.operation}: transaction ${signature} failed: ${e instanceof Error ? e.message : String(e)}`,
      { operation: ctx.operation, step, logs: await logsOf(ctx, signature), cause: e },
    );
  }
  return signature;
}

async function latestLifetime(ctx: SendContext): Promise<BlockhashLifetime> {
  const { value } = await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  return value;
}

/** One transaction: build, sign, simulate, send, confirm. */
export async function sendInstructions(ctx: SendContext, instructions: Instruction[]): Promise<Signature> {
  const lifetime = await latestLifetime(ctx);
  const message = withPriorityFee(
    pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(ctx.payer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
    ),
    ctx.computeUnitPrice,
  );
  const [tx] = await signTransactionMessagesTogether([message], lifetime);
  return simulateAndSend(ctx, tx, ctx.operation);
}

export type ProofFlowResult = {
  signatures: Signature[];
  /** Proof accounts still open after the operation succeeded (normally none). */
  proofAccountsLeftOpen: Address[];
};

/**
 * A transfer or withdraw: plan every transaction, sign them all together, send them in order.
 * `actionStep` names the main step in errors ("transfer", "withdraw").
 */
export async function executeProofFlow(ctx: SendContext, flow: ProofFlow, actionStep: string): Promise<ProofFlowResult> {
  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(createTransactionMessage({ version: 0 }), (tx) => setTransactionMessageFeePayerSigner(ctx.payer, tx)),
  });
  const plan = await planner(proofFlowToPlan(flow));
  const planned = flattenTransactionPlan(plan).map((single) => single.message as Message);
  const actionIndex = planned.findIndex((m) => m.instructions.includes(flow.action));

  const lifetime = await latestLifetime(ctx);
  const messages = planned.map((m) =>
    withPriorityFee(setTransactionMessageLifetimeUsingBlockhash(lifetime, m as never) as Message, ctx.computeUnitPrice),
  );
  const transactions = await signTransactionMessagesTogether(messages, lifetime);

  const signatures: Signature[] = [];
  for (let i = 0; i < transactions.length; i++) {
    const step = actionIndex === -1 || i < actionIndex ? "proofs" : actionStep;
    try {
      signatures.push(await simulateAndSend(ctx, transactions[i], step));
    } catch (e) {
      const actionLanded = actionIndex !== -1 && i > actionIndex;
      const proofAccounts = await closeProofAccounts(ctx, flow.proofAccounts);
      if (actionLanded) {
        // The transfer or withdraw itself went through; only the cleanup did not.
        return { signatures, proofAccountsLeftOpen: proofAccounts.leftOpen };
      }
      const error = isConfidentialTransfersError(e)
        ? e
        : new ConfidentialTransfersError("TRANSACTION_FAILED", `${ctx.operation} failed: ${String(e)}`, { cause: e });
      throw new ConfidentialTransfersError(error.code, withCleanupNote(error.message, proofAccounts), {
        operation: ctx.operation,
        step,
        logs: error.logs,
        signatures,
        proofAccounts,
        retryable: error.retryable,
        cause: error.cause ?? e,
      });
    }
  }
  return { signatures, proofAccountsLeftOpen: [] };
}

function withCleanupNote(message: string, proofAccounts: { closed: readonly Address[]; leftOpen: readonly Address[] }): string {
  if (proofAccounts.leftOpen.length > 0) {
    return `${message}\n${proofAccounts.leftOpen.length} proof account(s) could not be closed: ${proofAccounts.leftOpen.join(", ")}. recoverProofAccounts() closes them and returns their rent.`;
  }
  if (proofAccounts.closed.length > 0) {
    return `${message}\nThe ${proofAccounts.closed.length} proof account(s) created before the failure were closed and their rent returned.`;
  }
  return message;
}

/** Close whichever of `addresses` exist (proof context accounts whose authority is the payer). */
export async function closeProofAccounts(
  ctx: SendContext,
  addresses: readonly Address[],
): Promise<{ closed: Address[]; leftOpen: Address[] }> {
  if (addresses.length === 0) return { closed: [], leftOpen: [] };
  let existing: Address[];
  try {
    const { value } = await ctx.rpc.getMultipleAccounts([...addresses], { encoding: "base64", commitment: "confirmed" }).send();
    existing = addresses.filter((_, i) => value[i] != null && value[i]!.owner === ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS);
  } catch {
    return { closed: [], leftOpen: [...addresses] };
  }
  if (existing.length === 0) return { closed: [], leftOpen: [] };
  const closed: Address[] = [];
  const cleanupCtx = { ...ctx, operation: `${ctx.operation} (closing proof accounts)` };
  for (let i = 0; i < existing.length; i += CLOSES_PER_TRANSACTION) {
    const batch = existing.slice(i, i + CLOSES_PER_TRANSACTION);
    try {
      await sendInstructions(
        cleanupCtx,
        batch.map((contextState) => closeContextStateProof({ contextState, authority: ctx.payer, destination: ctx.payer.address })),
      );
      closed.push(...batch);
    } catch {
      // left open; reported to the caller
    }
  }
  return { closed, leftOpen: existing.filter((a) => !closed.includes(a)) };
}

const CLOSES_PER_TRANSACTION = 8;

/** Run `attempt`, again up to `retries` times while it fails with a retryable error. */
export async function withRetries<T>(retries: number | undefined, attempt: () => Promise<T>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (e) {
      if (n >= (retries ?? 0) || !(isConfidentialTransfersError(e) && e.retryable)) throw e;
    }
  }
}
