// SPDX-License-Identifier: Apache-2.0
//
// Confidential Transfers SDK — public API.
export { configureAccount } from "./configureAccount";
export type { ConfigureAccountInput, ConfigureAccountResult } from "./configureAccount";
export {
  deriveAeKey,
  deriveAeKeyForOwnerMint,
  deriveConfidentialKeypairs,
  deriveElGamalKeypair,
  deriveElGamalKeypairForOwnerMint,
} from "./keys";
export type { ConfidentialKeypairs, DerivedElGamalKeypair } from "./keys";
