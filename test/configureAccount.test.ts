// SPDX-License-Identifier: Apache-2.0
//
// Integration test for configureAccount(). REQUIRES a CT-capable local
// validator (proof program enabled). In another terminal first run:
//   npm run validator
//
// It creates a fresh confidential-transfer mint, configures an owner's
// associated token account for confidential transfers, and asserts the
// on-chain account gained the ConfidentialTransferAccount extension.
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  fetchToken,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
} from "@solana-program/token-2022";
import {
  airdropFactory,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  isSome,
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
import { expect } from "chai";

import { configureAccount } from "../src/configureAccount";

const RPC_URL = "http://127.0.0.1:8899";
const RPC_WS_URL = "ws://127.0.0.1:8900";

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const airdrop = airdropFactory({ rpc, rpcSubscriptions });

async function fundedSigner(sol = 2n): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  await airdrop({
    recipientAddress: signer.address,
    lamports: lamports(sol * 1_000_000_000n),
    commitment: "confirmed",
  });
  return signer;
}

async function sendInstructions(payer: TransactionSigner, instructions: Instruction[]): Promise<void> {
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
async function createConfidentialMint(payer: TransactionSigner): Promise<Address> {
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
      decimals: 2,
      mintAuthority: mintAuthority.address,
      freezeAuthority: none(),
    }),
  ]);
  return mint.address;
}

describe("configureAccount (integration)", function () {
  this.timeout(120000);

  it("configures an account for confidential transfers", async () => {
    const payer = await fundedSigner();
    const owner = await fundedSigner();
    const mint = await createConfidentialMint(payer);

    const result = await configureAccount({ rpc, rpcSubscriptions, payer, owner, mint });

    expect(result.signature).to.be.a("string");
    expect(result.token).to.be.a("string");

    const { data } = await fetchToken(rpc, result.token);
    expect(isSome(data.extensions), "token account has no extensions").to.equal(true);
    const exts = isSome(data.extensions) ? data.extensions.value : [];
    const ct = exts.find((e) => e.__kind === "ConfidentialTransferAccount");
    expect(ct, "missing ConfidentialTransferAccount extension").to.not.equal(undefined);
  });
});
