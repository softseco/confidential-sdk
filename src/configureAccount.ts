// SPDX-License-Identifier: Apache-2.0
//
// configureAccount(): configure a Token-2022 account for confidential transfers.
//
// Sends a single transaction that (1) creates the owner's associated token
// account if needed, (2) reallocates it for the confidential-transfer
// extension, (3) configures it with the owner's ElGamal public key and an
// encrypted zero balance, and (4) verifies the ZK pubkey-validity proof.
// Encryption keys are derived deterministically from the owner's wallet signer
// (see ./keys), so they are recoverable and never stored. Pass `keys` to reuse
// keys derived earlier instead of asking the wallet to sign again.
import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from "@solana/kit";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getConfigureConfidentialTransferAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getReallocateInstruction,
} from "@solana-program/token-2022";
import { verifyPubkeyValidity } from "@solana-program/zk-elgamal-proof";
import { PubkeyValidityProofData } from "./internal/zk";

import type { ConfidentialKeypairs } from "./keys";
import { ownerKeys } from "./internal/ownerKeys";

/** Default cap on un-applied incoming confidential credits (2^16). */
const DEFAULT_MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER = 1n << 16n;

export type ConfigureAccountInput = {
  /** RPC client, e.g. `createSolanaRpc(url)`. */
  rpc: Rpc<SolanaRpcApi>;
  /** Used to confirm the transaction(s). */
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** Pays transaction fees and account rent. */
  payer: TransactionSigner;
  /**
   * The token-account owner. Signs the configure instruction, and also the key-derivation message
   * unless `keys` is given (a keypair signer, or a wallet that supports signMessage).
   */
  owner: TransactionSigner;
  /**
   * The owner's keys from {@link deriveConfidentialKeys}, to configure the account without asking
   * the wallet to sign the key message again.
   */
  keys?: ConfidentialKeypairs;
  /** A mint already configured for confidential transfers. */
  mint: Address;
  /**
   * How many incoming deposits and transfers the account accepts before `applyPendingBalance`
   * must be called. Default: 65536.
   */
  maximumPendingBalanceCreditCounter?: number | bigint;
  /** Token program. Default: Token-2022. */
  programAddress?: Address;
};

/** The configured account, the keys it was configured with, and the transaction signature. */
export type ConfigureAccountResult = ConfidentialKeypairs & {
  /** The configured associated token account. */
  token: Address;
  /** Signature of the configure transaction. */
  signature: Signature;
};

/**
 * Configure the owner's token account for confidential transfers, in one transaction: create the
 * associated token account if needed, make room for the extension, set the owner's ElGamal key
 * and an encrypted zero balance, and verify the pubkey-validity proof.
 *
 * @example
 * ```ts
 * const { token } = await configureAccount({ rpc, rpcSubscriptions, payer, owner: alice, mint });
 * ```
 */
export async function configureAccount(
  input: ConfigureAccountInput,
): Promise<ConfigureAccountResult> {
  const programAddress = input.programAddress ?? TOKEN_2022_PROGRAM_ADDRESS;

  // 1. The account's encryption keys: given, or derived deterministically from the owner.
  const { elgamalKeypair, aesKey } = await ownerKeys(input.owner, input.keys, "configureAccount");

  // 2. Resolve the owner's associated token account.
  const [token] = await findAssociatedTokenPda({
    owner: input.owner.address,
    tokenProgram: programAddress,
    mint: input.mint,
  });

  // 3. Generate the pubkey-validity proof and its on-chain verify instruction.
  const proofData = new PubkeyValidityProofData(elgamalKeypair);
  const [verifyProofInstruction] = await verifyPubkeyValidity({
    rpc: input.rpc,
    payer: input.payer,
    proofData: new Uint8Array(proofData.toBytes()),
  });

  // 4. One transaction. configure's proofInstructionOffset = 1 points to the
  //    verify instruction that follows it.
  const instructions = [
    getCreateAssociatedTokenIdempotentInstruction({
      ata: token,
      mint: input.mint,
      owner: input.owner.address,
      payer: input.payer,
      tokenProgram: programAddress,
    }),
    getReallocateInstruction(
      {
        token,
        payer: input.payer,
        owner: input.owner,
        newExtensionTypes: [ExtensionType.ConfidentialTransferAccount],
      },
      { programAddress },
    ),
    getConfigureConfidentialTransferAccountInstruction(
      {
        token,
        mint: input.mint,
        authority: input.owner,
        decryptableZeroBalance: aesKey.encrypt(0n).toBytes(),
        maximumPendingBalanceCreditCounter:
          input.maximumPendingBalanceCreditCounter ??
          DEFAULT_MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER,
        proofInstructionOffset: 1,
      },
      { programAddress },
    ),
    verifyProofInstruction,
  ];

  // 5. Build, sign, simulate (to surface program logs on failure), send, confirm.
  const { value: latestBlockhash } = await input.rpc.getLatestBlockhash().send();
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(input.payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);

  const simulation = await input.rpc
    .simulateTransaction(getBase64EncodedWireTransaction(signedTransaction), {
      encoding: "base64",
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (simulation.value.err) {
    throw new Error(
      "configureAccount transaction failed simulation: " +
        JSON.stringify(simulation.value.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) +
        "\n--- program logs ---\n" +
        (simulation.value.logs ?? []).join("\n"),
    );
  }

  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  await sendAndConfirmTransactionFactory({
    rpc: input.rpc,
    rpcSubscriptions: input.rpcSubscriptions,
  })(signedTransaction, { commitment: "confirmed", skipPreflight: true });

  return {
    token,
    elgamalKeypair,
    aesKey,
    signature: getSignatureFromTransaction(signedTransaction),
  };
}
