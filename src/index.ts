// SPDX-License-Identifier: Apache-2.0
//
// Confidential Transfers SDK — public API.
export { configureAccount } from "./configureAccount";
export type { ConfigureAccountInput, ConfigureAccountResult } from "./configureAccount";
export { deposit } from "./deposit";
export type { DepositInput, DepositResult } from "./deposit";
export { applyPendingBalance } from "./applyPendingBalance";
export type { ApplyPendingBalanceInput, ApplyPendingBalanceResult } from "./applyPendingBalance";
export { decryptBalance } from "./decryptBalance";
export type { DecryptBalanceInput } from "./decryptBalance";
export { transfer } from "./transfer";
export type { TransferInput, TransferResult } from "./transfer";
export {
  decryptTransferAmountAsAuditor,
  deriveAuditorElgamalKeypair,
  getAuditorElgamalPubkey,
} from "./auditor";
export type { DecryptTransferAmountAsAuditorInput } from "./auditor";
export {
  findExtraAccountMetaListPda,
  getTransferHookProgram,
  resolveTransferHookAccounts,
} from "./internal/transferHook";
export type { ResolveTransferHookAccountsInput, ResolvedAccount } from "./internal/transferHook";
export {
  deriveAeKey,
  deriveConfidentialKeys,
  deriveConfidentialKeysWithSeed,
  deriveElGamalKeypair,
  getElGamalPubkeyAddress,
  pdaWalletPublicSeed,
} from "./keys";
export type { ConfidentialKeypairs, DerivedElGamalKeypair } from "./keys";
