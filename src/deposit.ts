// SPDX-License-Identifier: Apache-2.0
//
// deposit(): move tokens from the public balance into the confidential
// pending balance of a Token-2022 account. No zero-knowledge proof is
// required — the amount is publicly debited and credited to the encrypted
// pending balance. The account must already be configured for confidential
// transfers (see configureAccount) and hold a public token balance.
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
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getConfidentialDepositInstruction,
} from "@solana-program/token-2022";

export type DepositInput = {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  payer: TransactionSigner;
  /** Owner of the token account (signs the deposit). */
  owner: TransactionSigner;
  /** Mint configured for confidential transfers. */
  mint: Address;
  /** Amount of public tokens to move into the confidential pending balance. */
  amount: number | bigint;
  /** Mint decimals (must match the mint). */
  decimals: number;
  /** Token account to deposit into (defaults to the owner's ATA). */
  token?: Address;
  programAddress?: Address;
};

export type DepositResult = {
  token: Address;
  signature: Signature;
};

export async function deposit(input: DepositInput): Promise<DepositResult> {
  const programAddress = input.programAddress ?? TOKEN_2022_PROGRAM_ADDRESS;
  const token =
    input.token ??
    (
      await findAssociatedTokenPda({
        owner: input.owner.address,
        tokenProgram: programAddress,
        mint: input.mint,
      })
    )[0];

  const instruction = getConfidentialDepositInstruction(
    {
      token,
      mint: input.mint,
      authority: input.owner,
      amount: input.amount,
      decimals: input.decimals,
    },
    { programAddress },
  );

  const { value: latestBlockhash } = await input.rpc.getLatestBlockhash().send();
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(input.payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions([instruction], tx),
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
      "deposit transaction failed simulation: " +
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

  return { token, signature: getSignatureFromTransaction(signedTransaction) };
}
