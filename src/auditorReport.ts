// SPDX-License-Identifier: Apache-2.0
//
// The auditor's view of a mint: every deposit, confidential transfer and withdraw, with the
// amounts of the confidential transfers decrypted with the auditor's ElGamal key.
//
// Deposits and withdraws carry their amount in the clear. A confidential transfer carries it only
// encrypted, three times: for the sender, the recipient, and the mint's auditor. This module reads
// the mint's transaction history, finds those instructions (top-level and inside other programs'
// calls), and decrypts the auditor's copy of each transferred amount.
import {
  getBase58Encoder,
  isSome,
  type Address,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  CONFIDENTIAL_DEPOSIT_CONFIDENTIAL_TRANSFER_DISCRIMINATOR,
  CONFIDENTIAL_TRANSFER_CONFIDENTIAL_TRANSFER_DISCRIMINATOR,
  CONFIDENTIAL_TRANSFER_DISCRIMINATOR,
  CONFIDENTIAL_TRANSFER_WITH_FEE_CONFIDENTIAL_TRANSFER_DISCRIMINATOR,
  CONFIDENTIAL_WITHDRAW_CONFIDENTIAL_TRANSFER_DISCRIMINATOR,
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  getConfidentialDepositInstructionDataDecoder,
  getConfidentialTransferInstructionDataDecoder,
  getConfidentialWithdrawInstructionDataDecoder,
} from "@solana-program/token-2022";

import { getAuditorElgamalPubkey } from "./auditor";
import { ConfidentialTransfersError } from "./errors";
import { ElGamalCiphertext, ElGamalKeypair, ensureZk } from "./internal/zk";

const TRANSFER_AMOUNT_LO_BIT_LENGTH = 16n;

export type ConfidentialActivityKind = "deposit" | "transfer" | "withdraw" | "transfer-with-fee";

/** One movement in or out of a confidential balance. */
export type ConfidentialActivity = {
  signature: Signature;
  slot: bigint;
  /** When the block was produced, if the RPC knows. */
  blockTime: Date | null;
  /**
   * `deposit`: public balance → confidential balance of the same account. `withdraw`: the other
   * way. `transfer`: confidential balance of one account → another. `transfer-with-fee`: a
   * transfer on a mint with a transfer fee; listed, but its amount is not decrypted (yet).
   */
  kind: ConfidentialActivityKind;
  fromToken: Address;
  /** Owner of `fromToken` at the time, if the transaction records it. */
  fromOwner: Address | null;
  toToken: Address;
  toOwner: Address | null;
  /** Amount in base units. Null when it could not be decrypted (see `note`). */
  amount: bigint | null;
  /** True when the amount was encrypted on chain and decrypted with the auditor key. */
  decrypted: boolean;
  note?: string;
};

export type ListConfidentialActivityInput = {
  /** RPC client. It must serve `getSignaturesForAddress` and `getTransaction` for the period. */
  rpc: Rpc<SolanaRpcApi>;
  mint: Address;
  /** The mint's auditor keypair, from {@link deriveAuditorElgamalKeypair}. */
  auditorKeypair: ElGamalKeypair;
  /** Only activity at or after this time. */
  since?: Date;
  /** Only activity before this time. */
  until?: Date;
  /** Stop after reading this many of the mint's transactions (newest first). Default: all. */
  maxTransactions?: number;
  /** How many transactions to fetch at a time. Default 4; lower it if the RPC rate-limits. */
  concurrency?: number;
  /**
   * Skip the check that `auditorKeypair` is the mint's current auditor key. Use it for a mint whose
   * auditor key was changed: transfers from before the change are then reported as not decryptable.
   */
  skipAuditorKeyCheck?: boolean;
  programAddress?: Address;
};

type RawInstruction = { programIdIndex: number; accounts: readonly number[]; data: string };
type RawTransaction = {
  slot: bigint;
  blockTime: bigint | null;
  transaction: { message: { accountKeys: readonly Address[]; instructions: readonly RawInstruction[] } };
  meta: {
    err: unknown;
    innerInstructions?: ReadonlyArray<{ index: number; instructions: readonly RawInstruction[] }> | null;
    loadedAddresses?: { writable: readonly Address[]; readonly: readonly Address[] } | null;
    preTokenBalances?: ReadonlyArray<{ accountIndex: number; owner?: Address }> | null;
  } | null;
};

/**
 * Every deposit, confidential transfer and withdraw of `mint`, oldest first, with the transferred
 * amounts decrypted with the auditor's key. Failed transactions are left out.
 *
 * @example
 * ```ts
 * const auditorKeypair = await deriveAuditorElgamalKeypair(auditorWallet);
 * const activity = await listConfidentialActivity({ rpc, mint, auditorKeypair });
 * console.log(confidentialActivityToCsv(activity, { decimals: 6 }));
 * ```
 */
export async function listConfidentialActivity(input: ListConfidentialActivityInput): Promise<ConfidentialActivity[]> {
  const operation = "listConfidentialActivity";
  await ensureZk();
  const programAddress = input.programAddress ?? TOKEN_2022_PROGRAM_ADDRESS;

  if (!input.skipAuditorKeyCheck) {
    const mint = await readMint(input.rpc, input.mint, operation);
    const extensions = isSome(mint.data.extensions) ? mint.data.extensions.value : [];
    const ct = extensions.find((e) => e.__kind === "ConfidentialTransferMint");
    const auditor = ct && isSome(ct.auditorElgamalPubkey) ? ct.auditorElgamalPubkey.value : null;
    const ours = getAuditorElgamalPubkey(input.auditorKeypair);
    if (auditor !== ours) {
      throw new ConfidentialTransfersError(
        "KEYS_MISMATCH",
        `${operation}: mint ${input.mint} ` +
          (auditor ? `has auditor key ${auditor}, not ${ours}.` : "has no auditor key, so nobody can read its transfer amounts.") +
          " Pass skipAuditorKeyCheck if the auditor key was changed and you want the transfers this key can read.",
        { operation },
      );
    }
  }

  const signatures = await signaturesOf(input);
  const secret = input.auditorKeypair.secret();
  const base58 = getBase58Encoder();
  // Entries per transaction, in the order the RPC lists them: newest first.
  const perTransaction: ConfidentialActivity[][] = [];

  const concurrency = Math.max(1, input.concurrency ?? 4);
  for (let i = 0; i < signatures.length; i += concurrency) {
    const batch = signatures.slice(i, i + concurrency);
    const transactions = await Promise.all(
      batch.map((s) =>
        input.rpc
          .getTransaction(s, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 })
          .send() as unknown as Promise<RawTransaction | null>,
      ),
    );
    transactions.forEach((tx, k) => {
      const entries: ConfidentialActivity[] = [];
      perTransaction.push(entries);
      if (!tx || !tx.meta || tx.meta.err) return;
      const keys = [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ];
      const owners = new Map<number, Address>();
      for (const b of tx.meta.preTokenBalances ?? []) if (b.owner) owners.set(b.accountIndex, b.owner);
      // Each top-level instruction, followed by the instructions it invoked (other programs can
      // make confidential transfers through cross-program calls).
      const inner = new Map<number, readonly RawInstruction[]>();
      for (const group of tx.meta.innerInstructions ?? []) inner.set(group.index, group.instructions);
      const all = tx.transaction.message.instructions.flatMap((ix, i) => [ix, ...(inner.get(i) ?? [])]);
      for (const ix of all) {
        if (keys[ix.programIdIndex] !== programAddress) continue;
        const data = new Uint8Array(base58.encode(ix.data));
        if (data[0] !== CONFIDENTIAL_TRANSFER_DISCRIMINATOR || ix.accounts.length < 2) continue;
        // In every client, the token account comes first and the mint second; for a transfer the
        // destination is third. The accounts after that differ between clients.
        if (keys[ix.accounts[1]] !== input.mint) continue;
        const entry = toActivity(data, ix, keys, owners, secret);
        if (!entry) continue;
        entries.push({
          signature: batch[k],
          slot: BigInt(tx.slot),
          blockTime: tx.blockTime == null ? null : new Date(Number(tx.blockTime) * 1000),
          ...entry,
        });
      }
    });
  }

  // Oldest first; within a transaction, in instruction order.
  return perTransaction.reverse().flat();
}

/** The mint account, or a clear error when the address is not a Token-2022 mint. */
export async function readMint(rpc: Rpc<SolanaRpcApi>, mint: Address, operation: string) {
  try {
    return await fetchMint(rpc, mint);
  } catch (e) {
    throw new ConfidentialTransfersError("INVALID_INPUT", `${operation}: ${mint} is not a Token-2022 mint (or does not exist).`, {
      operation,
      cause: e,
    });
  }
}

function toActivity(
  data: Uint8Array,
  ix: RawInstruction,
  keys: readonly Address[],
  owners: Map<number, Address>,
  secret: ReturnType<ElGamalKeypair["secret"]>,
): Omit<ConfidentialActivity, "signature" | "slot" | "blockTime"> | null {
  const at = (i: number) => ({ token: keys[ix.accounts[i]], owner: owners.get(ix.accounts[i]) ?? null });
  switch (data[1]) {
    case CONFIDENTIAL_DEPOSIT_CONFIDENTIAL_TRANSFER_DISCRIMINATOR: {
      const { amount } = getConfidentialDepositInstructionDataDecoder().decode(data);
      const a = at(0);
      return { kind: "deposit", fromToken: a.token, fromOwner: a.owner, toToken: a.token, toOwner: a.owner, amount, decrypted: false };
    }
    case CONFIDENTIAL_WITHDRAW_CONFIDENTIAL_TRANSFER_DISCRIMINATOR: {
      const { amount } = getConfidentialWithdrawInstructionDataDecoder().decode(data);
      const a = at(0);
      return { kind: "withdraw", fromToken: a.token, fromOwner: a.owner, toToken: a.token, toOwner: a.owner, amount, decrypted: false };
    }
    case CONFIDENTIAL_TRANSFER_CONFIDENTIAL_TRANSFER_DISCRIMINATOR: {
      const decoded = getConfidentialTransferInstructionDataDecoder().decode(data);
      const from = at(0);
      const to = at(2);
      const base = { kind: "transfer" as const, fromToken: from.token, fromOwner: from.owner, toToken: to.token, toOwner: to.owner };
      try {
        const lo = ElGamalCiphertext.fromBytes(new Uint8Array(decoded.transferAmountAuditorCiphertextLo));
        const hi = ElGamalCiphertext.fromBytes(new Uint8Array(decoded.transferAmountAuditorCiphertextHi));
        if (!lo || !hi) throw new Error("malformed ciphertext");
        const amount = secret.decrypt(lo) + (secret.decrypt(hi) << TRANSFER_AMOUNT_LO_BIT_LENGTH);
        return { ...base, amount, decrypted: true };
      } catch {
        return { ...base, amount: null, decrypted: false, note: "not encrypted to this auditor key" };
      }
    }
    case CONFIDENTIAL_TRANSFER_WITH_FEE_CONFIDENTIAL_TRANSFER_DISCRIMINATOR: {
      const from = at(0);
      const to = at(2);
      return {
        kind: "transfer-with-fee", fromToken: from.token, fromOwner: from.owner, toToken: to.token, toOwner: to.owner,
        amount: null, decrypted: false, note: "transfer with fee: amount not decrypted by this version",
      };
    }
    default:
      return null;
  }
}

async function signaturesOf(input: ListConfidentialActivityInput): Promise<Signature[]> {
  const out: Signature[] = [];
  const sinceSeconds = input.since ? BigInt(Math.floor(input.since.getTime() / 1000)) : undefined;
  const untilSeconds = input.until ? BigInt(Math.floor(input.until.getTime() / 1000)) : undefined;
  let before: Signature | undefined;
  for (;;) {
    const page = await input.rpc.getSignaturesForAddress(input.mint, { before, limit: 1000, commitment: "confirmed" }).send();
    if (page.length === 0) break;
    for (const s of page) {
      if (input.maxTransactions !== undefined && out.length >= input.maxTransactions) return out;
      const time = s.blockTime == null ? undefined : BigInt(s.blockTime);
      if (sinceSeconds !== undefined && time !== undefined && time < sinceSeconds) return out; // older than wanted: done
      if (untilSeconds !== undefined && time !== undefined && time >= untilSeconds) continue;
      if (s.err) continue;
      out.push(s.signature);
    }
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  return out;
}

export type ConfidentialActivityCsvOptions = {
  /** Mint decimals; adds an `amount` column in tokens next to the base units. */
  decimals?: number;
};

/**
 * The activity as CSV (RFC 4180, comma-separated, one header row), ready for a spreadsheet. Times
 * are UTC in ISO 8601.
 */
export function confidentialActivityToCsv(activity: readonly ConfidentialActivity[], options: ConfidentialActivityCsvOptions = {}): string {
  const header = ["time_utc", "slot", "signature", "kind", "from_owner", "from_account", "to_owner", "to_account", "amount_base_units"];
  if (options.decimals !== undefined) header.push("amount");
  header.push("decrypted", "note");
  const rows = activity.map((a) => {
    const row = [
      a.blockTime ? a.blockTime.toISOString() : "",
      a.slot.toString(),
      a.signature,
      a.kind,
      a.fromOwner ?? "",
      a.fromToken,
      a.toOwner ?? "",
      a.toToken,
      a.amount === null ? "" : a.amount.toString(),
    ];
    if (options.decimals !== undefined) row.push(a.amount === null ? "" : formatUnits(a.amount, options.decimals));
    row.push(a.decrypted ? "yes" : "no", a.note ?? "");
    return row.map(csvField).join(",");
  });
  return [header.join(","), ...rows].join("\r\n") + "\r\n";
}

function formatUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
