// SPDX-License-Identifier: Apache-2.0
//
// configureAccount(): configure a Token-2022 account for confidential transfers.
//
// Sends a single transaction that (1) creates the owner's associated token
// account if needed, (2) reallocates it for the confidential-transfer
// extension, (3) configures it with the owner's ElGamal public key and an
// encrypted zero balance, and (4) verifies the ZK pubkey-validity proof.
// Encryption keys are derived deterministically from the owner's wallet signer
// (see ./keys), so they are recoverable and never stored.
import {
  appendTransactionMessageInstructions,
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
import { PubkeyValidityProofData } from "@solana/zk-sdk/node";

import { deriveConfidentialKeypairs, type ConfidentialKeypairs } from "./keys";

/** Default cap on un-applied incoming confidential credits (2^16). */
const DEFAULT_MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER = 1n << 16n;

export type ConfigureAccountInput = {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** Pays transaction fees and account rent. */
  payer: TransactionSigner;
  /** The token-account owner. Signs key derivation and the configure instruction. */
  owner: TransactionSigner;
  /** A mint already configured for confidential transfers. */
  mint: Address;
  maximumPendingBalanceCreditCounter?: number | bigint;
  programAddress?: Address;
};

export type ConfigureAccountResult = ConfidentialKeypairs & {
  /** The configured associated token account. */
  token: Address;
  /** Signature of the configure transaction. */
  signature: Signature;
};

export async function configureAccount(
  input: ConfigureAccountInput,
): Promise<ConfigureAccountResult> {
  const programAddress = input.programAddress ?? TOKEN_2022_PROGRAM_ADDRESS;

  // 1. Derive the account's encryption keys deterministically from the owner.
  const { elgamalKeypair, aesKey } = await deriveConfidentialKeypairs({
    signer: input.owner,
    owner: input.owner.address,
    mint: input.mint,
  });

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
