// SPDX-License-Identifier: Apache-2.0
//
// Shared harness for integration tests against a local CT-capable validator
// (Agave 4.x with the ZK ElGamal Proof Program enabled). Start one first:
//   npm run validator
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from "@solana-program/token-2022";
import {
  airdropFactory,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  none,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  some,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";

export const RPC_URL = "http://127.0.0.1:8899";
export const RPC_WS_URL = "ws://127.0.0.1:8900";

export const rpc = createSolanaRpc(RPC_URL);
export const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_WS_URL);

const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const airdrop = airdropFactory({ rpc, rpcSubscriptions });

export async function fundedSigner(sol = 2n): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  await airdrop({
    recipientAddress: signer.address,
    lamports: lamports(sol * 1_000_000_000n),
    commitment: "confirmed",
  });
  return signer;
}

export async function sendInstructions(
  payer: TransactionSigner,
  instructions: Instruction[],
): Promise<void> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await sendAndConfirm(signed, { commitment: "confirmed" });
}

/** Create a fresh mint configured for confidential transfers (auto-approve). */
export async function createConfidentialMint(
  payer: TransactionSigner,
  decimals = 2,
): Promise<{ mint: Address; mintAuthority: KeyPairSigner; decimals: number }> {
  const [mint, mintAuthority] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const ctMintExtension = extension("ConfidentialTransferMint", {
    authority: some(mintAuthority.address),
    autoApproveNewAccounts: true,
    auditorElgamalPubkey: none(),
  });
  const space = BigInt(getMintSize([ctMintExtension]));
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();

  await sendInstructions(payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: rent,
      space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeConfidentialTransferMintInstruction({
      mint: mint.address,
      authority: some(mintAuthority.address),
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: none(),
    }),
    getInitializeMint2Instruction({
      mint: mint.address,
      decimals,
      mintAuthority: mintAuthority.address,
      freezeAuthority: none(),
    }),
  ]);
  return { mint: mint.address, mintAuthority, decimals };
}

/** Mint public (non-confidential) tokens into an existing token account. */
export async function mintPublicTokens(input: {
  payer: TransactionSigner;
  mint: Address;
  token: Address;
  mintAuthority: TransactionSigner;
  amount: bigint;
}): Promise<void> {
  await sendInstructions(input.payer, [
    getMintToInstruction({
      mint: input.mint,
      token: input.token,
      mintAuthority: input.mintAuthority,
      amount: input.amount,
    }),
  ]);
}
