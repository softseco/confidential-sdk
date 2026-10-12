// SPDX-License-Identifier: Apache-2.0
//
// Reading token accounts before acting on them, so that a missing account, a missing extension or
// a full pending balance fails with a clear error before anything is signed or sent.
import { isSome, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { fetchMaybeToken, type Extension, type Token } from "@solana-program/token-2022";

import { ConfidentialTransfersError } from "../errors";

export type ConfidentialTransferAccountState = Extract<Extension, { __kind: "ConfidentialTransferAccount" }>;

/** Most a single deposit or transfer can carry: 2^48 - 1 base units (16 + 32 bits). */
export const MAX_DEPOSIT_OR_TRANSFER_AMOUNT = (1n << 48n) - 1n;

export function confidentialState(account: Pick<Token, "extensions">): ConfidentialTransferAccountState | undefined {
  if (!isSome(account.extensions)) return undefined;
  return account.extensions.value.find(
    (e): e is ConfidentialTransferAccountState => e.__kind === "ConfidentialTransferAccount",
  );
}

/**
 * Fetch a token account that must exist and be configured for confidential transfers.
 * `whose` goes into the error message: "your", "the recipient's".
 */
export async function readConfiguredAccount(
  rpc: Rpc<SolanaRpcApi>,
  token: Address,
  operation: string,
  whose = "the",
): Promise<{ data: Token; ct: ConfidentialTransferAccountState }> {
  const account = await fetchMaybeToken(rpc, token);
  if (!account.exists) {
    throw new ConfidentialTransfersError(
      "ACCOUNT_NOT_FOUND",
      `${operation}: ${whose} token account ${token} does not exist. It is created by configureAccount.`,
      { operation },
    );
  }
  const ct = confidentialState(account.data);
  if (!ct) {
    throw new ConfidentialTransfersError(
      "ACCOUNT_NOT_CONFIGURED",
      `${operation}: ${whose} token account ${token} is missing the ConfidentialTransferAccount extension; ` +
        "it has to be set up with configureAccount first.",
      { operation },
    );
  }
  return { data: account.data, ct };
}

/** Throws unless the account can take one more incoming deposit or transfer. */
export function assertCanReceive(
  ct: ConfidentialTransferAccountState,
  token: Address,
  operation: string,
  whose: "your" | "the recipient's",
): void {
  if (!ct.approved) {
    throw new ConfidentialTransfersError(
      "ACCOUNT_NOT_APPROVED",
      `${operation}: ${whose} token account ${token} has not been approved for confidential transfers by the mint's confidential-transfer authority.`,
      { operation },
    );
  }
  if (!ct.allowConfidentialCredits) {
    throw new ConfidentialTransfersError(
      "RECIPIENT_REJECTS_CONFIDENTIAL",
      `${operation}: ${whose} token account ${token} does not accept confidential credits.`,
      { operation },
    );
  }
  if (ct.pendingBalanceCreditCounter >= ct.maximumPendingBalanceCreditCounter) {
    throw new ConfidentialTransfersError(
      "PENDING_BALANCE_LIMIT",
      `${operation}: ${whose} token account ${token} has received ${ct.pendingBalanceCreditCounter} deposits or ` +
        "transfers since its pending balance was last applied, the most it takes. " +
        (whose === "your" ? "Run applyPendingBalance first." : "The recipient has to run applyPendingBalance first."),
      { operation },
    );
  }
}
