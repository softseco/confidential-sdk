// SPDX-License-Identifier: Apache-2.0
//
// Integration test for auditor-key selective disclosure. Requires a CT-capable
// validator:  CT_LOCAL_PROGRAM=1 npm test
import { expect } from "chai";

import { applyPendingBalance } from "../src/applyPendingBalance";
import {
  decryptTransferAmountAsAuditor,
  deriveAuditorElgamalKeypair,
  getAuditorElgamalPubkey,
} from "../src/auditor";
import { configureAccount } from "../src/configureAccount";
import { deposit } from "../src/deposit";
import { transfer } from "../src/transfer";
import {
  createConfidentialMint,
  fundedSigner,
  mintPublicTokens,
  rpc,
  rpcSubscriptions,
} from "./_helpers";

const describeOnChain = process.env.CT_LOCAL_PROGRAM === "1" ? describe : describe.skip;

describeOnChain("auditor selective disclosure (integration)", function () {
  this.timeout(180000);

  before(async function () {
    try {
      await rpc.getVersion().send();
    } catch {
      this.skip();
    }
  });

  it("lets the designated auditor recover a confidential transfer amount", async () => {
    const payer = await fundedSigner();
    const alice = await fundedSigner();
    const bob = await fundedSigner();
    const auditor = await fundedSigner();

    // The auditor holds an ElGamal keypair; its public key goes into the mint.
    const auditorKeypair = await deriveAuditorElgamalKeypair(auditor);
    const auditorPubkey = getAuditorElgamalPubkey(auditorKeypair);
    const { mint, mintAuthority, decimals } = await createConfidentialMint(payer, 2, auditorPubkey);

    const { token: aliceToken } = await configureAccount({ rpc, rpcSubscriptions, payer, owner: alice, mint });
    await configureAccount({ rpc, rpcSubscriptions, payer, owner: bob, mint });

    const amount = 1000n;
    await mintPublicTokens({ payer, mint, token: aliceToken, mintAuthority, amount });
    await deposit({ rpc, rpcSubscriptions, payer, owner: alice, mint, amount, decimals });
    await applyPendingBalance({ rpc, rpcSubscriptions, payer, owner: alice, mint });

    // Transfer must encrypt the amount to the mint's auditor too.
    const { signatures } = await transfer({
      rpc,
      rpcSubscriptions,
      payer,
      owner: alice,
      mint,
      destinationOwner: bob.address,
      amount,
      auditorElgamalPubkey: auditorPubkey,
    });

    // The auditor recovers the amount from whichever transaction holds the transfer.
    let recovered: bigint | undefined;
    for (const signature of signatures) {
      try {
        recovered = await decryptTransferAmountAsAuditor({ rpc, signature, auditorKeypair });
        break;
      } catch {
        // not the transfer instruction's transaction — try the next signature
      }
    }
    expect(recovered).to.equal(amount);
  });
});
