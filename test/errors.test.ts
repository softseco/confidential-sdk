// SPDX-License-Identifier: Apache-2.0
//
// Integration tests for error / guard paths. Require a CT-capable validator:
//   TOKEN_2022_SO=/path/to/spl_token_2022.so npm run validator
//   CT_LOCAL_PROGRAM=1 npm test
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token-2022";
import { expect } from "chai";

import { applyPendingBalance } from "../src/applyPendingBalance";
import { configureAccount } from "../src/configureAccount";
import { decryptBalance } from "../src/decryptBalance";
import { deposit } from "../src/deposit";
import { transfer } from "../src/transfer";
import {
  createConfidentialMint,
  fundedSigner,
  mintPublicTokens,
  rpc,
  rpcSubscriptions,
  sendInstructions,
} from "./_helpers";

const describeOnChain = process.env.CT_LOCAL_PROGRAM === "1" ? describe : describe.skip;

async function expectRejection(promise: Promise<unknown>, contains: string): Promise<void> {
  let err: unknown;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err, "expected the call to reject").to.be.an("error");
  expect((err as Error).message).to.contain(contains);
}

/** Create the owner's ATA without configuring it for confidential transfers. */
async function createUnconfiguredAccount(payer: Awaited<ReturnType<typeof fundedSigner>>, mint: string) {
  const owner = await fundedSigner();
  const [token] = await findAssociatedTokenPda({
    owner: owner.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint: mint as never,
  });
  await sendInstructions(payer, [
    getCreateAssociatedTokenIdempotentInstruction({
      ata: token,
      mint: mint as never,
      owner: owner.address,
      payer,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
  ]);
  return owner;
}

describeOnChain("error & guard paths (integration)", function () {
  this.timeout(120000);

  before(async function () {
    try {
      await rpc.getVersion().send();
    } catch {
      this.skip();
    }
  });

  it("decryptBalance and applyPendingBalance reject an account without the CT extension", async () => {
    const payer = await fundedSigner();
    const { mint } = await createConfidentialMint(payer);
    const owner = await createUnconfiguredAccount(payer, mint);

    await expectRejection(decryptBalance({ rpc, owner, mint }), "ConfidentialTransferAccount");
    await expectRejection(
      applyPendingBalance({ rpc, rpcSubscriptions, payer, owner, mint }),
      "ConfidentialTransferAccount",
    );
  });

  it("deposit surfaces program logs when the account is not configured", async () => {
    const payer = await fundedSigner();
    const { mint, decimals } = await createConfidentialMint(payer);
    const owner = await createUnconfiguredAccount(payer, mint);

    await expectRejection(
      deposit({ rpc, rpcSubscriptions, payer, owner, mint, amount: 1n, decimals }),
      "failed simulation",
    );
  });

  it("transfer rejects an amount greater than the available balance", async () => {
    const payer = await fundedSigner();
    const alice = await fundedSigner();
    const bob = await fundedSigner();
    const { mint, mintAuthority, decimals } = await createConfidentialMint(payer);

    const { token: aliceToken } = await configureAccount({ rpc, rpcSubscriptions, payer, owner: alice, mint });
    await configureAccount({ rpc, rpcSubscriptions, payer, owner: bob, mint });
    await mintPublicTokens({ payer, mint, token: aliceToken, mintAuthority, amount: 100n });
    await deposit({ rpc, rpcSubscriptions, payer, owner: alice, mint, amount: 100n, decimals });
    await applyPendingBalance({ rpc, rpcSubscriptions, payer, owner: alice, mint });

    await expectRejection(
      transfer({
        rpc,
        rpcSubscriptions,
        payer,
        owner: alice,
        mint,
        destinationOwner: bob.address,
        amount: 1000n,
      }),
      "Insufficient funds",
    );
  });

  it("configureAccount fails when the account is already configured", async () => {
    const payer = await fundedSigner();
    const owner = await fundedSigner();
    const { mint } = await createConfidentialMint(payer);
    await configureAccount({ rpc, rpcSubscriptions, payer, owner, mint });
    await expectRejection(
      configureAccount({ rpc, rpcSubscriptions, payer, owner, mint }),
      "failed simulation",
    );
  });
});
