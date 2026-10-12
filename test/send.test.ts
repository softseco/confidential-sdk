// SPDX-License-Identifier: Apache-2.0
//
// Validator-free tests for the sending layer and the typed errors: signing several transactions
// in one request per signer, retrying only what is safe to retry, and the input checks that fail
// before anything touches the network.
import { getTransferSolInstruction } from "@solana-program/system";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  isFullySignedTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type KeyPairSigner,
  type TransactionModifyingSigner,
} from "@solana/kit";
import { expect } from "chai";

import { ConfidentialTransfersError, deposit, isConfidentialTransfersError, transfer } from "../src/index";
import { signTransactionMessagesTogether, withRetries } from "../src/internal/send";

const lifetime = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 100n };

function walletLike(keypair: KeyPairSigner) {
  const counts = { requests: 0, transactions: 0 };
  const signer: TransactionModifyingSigner = {
    address: keypair.address,
    async modifyAndSignTransactions(txs) {
      counts.requests += 1;
      counts.transactions += txs.length;
      const dictionaries = await keypair.signTransactions(txs as never);
      return txs.map((tx, i) => Object.freeze({ ...tx, signatures: { ...tx.signatures, ...dictionaries[i] } })) as never;
    },
  };
  return { signer, counts };
}

async function rejection(promise: Promise<unknown>): Promise<ConfidentialTransfersError> {
  try {
    await promise;
  } catch (e) {
    if (isConfidentialTransfersError(e)) return e;
    throw e;
  }
  throw new Error("expected the call to reject");
}

describe("signing several transactions together", () => {
  it("asks a wallet once for every transaction it signs, and still lets keypairs co-sign", async () => {
    const [walletKey, other, extra] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    const { signer: wallet, counts } = walletLike(walletKey);
    const message = (cosigner?: KeyPairSigner) =>
      pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageFeePayerSigner(wallet, tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
        (tx) =>
          appendTransactionMessageInstructions(
            [getTransferSolInstruction({ source: cosigner ?? wallet, destination: other.address, amount: lamports(1n) })],
            tx,
          ),
      );
    const transactions = await signTransactionMessagesTogether([message(), message(extra), message()], lifetime);
    expect(counts.requests).to.equal(1);
    expect(counts.transactions).to.equal(3);
    expect(transactions.every((tx) => isFullySignedTransaction(tx))).to.equal(true);
    expect(transactions.every((tx) => tx.lifetimeConstraint.blockhash === lifetime.blockhash)).to.equal(true);
  });
});

describe("retries", () => {
  it("runs again after an expired transaction, up to the limit", async () => {
    let calls = 0;
    const result = await withRetries(2, async () => {
      calls += 1;
      if (calls < 3) throw new ConfidentialTransfersError("TRANSACTION_EXPIRED", "expired");
      return "ok";
    });
    expect(result).to.equal("ok");
    expect(calls).to.equal(3);
  });

  it("does not retry by default, and never retries a failed transaction", async () => {
    let calls = 0;
    const expired = await rejection(
      withRetries(undefined, async () => {
        calls += 1;
        throw new ConfidentialTransfersError("TRANSACTION_EXPIRED", "expired");
      }),
    );
    expect(expired.retryable).to.equal(true);
    expect(calls).to.equal(1);

    calls = 0;
    const failed = await rejection(
      withRetries(5, async () => {
        calls += 1;
        throw new ConfidentialTransfersError("TRANSACTION_FAILED", "refused");
      }),
    );
    expect(failed.retryable).to.equal(false);
    expect(calls).to.equal(1);
  });
});

describe("input checks before the network", () => {
  const offline = { rpc: {} as never, rpcSubscriptions: {} as never };

  it("deposit refuses zero and more than 2^48 - 1", async () => {
    const owner = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;
    const zero = await rejection(deposit({ ...offline, payer: owner, owner, mint, amount: 0n, decimals: 2 }));
    expect(zero.code).to.equal("INVALID_INPUT");
    const big = await rejection(deposit({ ...offline, payer: owner, owner, mint, amount: 1n << 48n, decimals: 2 }));
    expect(big.code).to.equal("AMOUNT_TOO_LARGE");
    expect(big.operation).to.equal("deposit");
  });

  it("transfer refuses zero and a missing destination", async () => {
    const owner = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;
    expect((await rejection(transfer({ ...offline, payer: owner, owner, mint, destinationOwner: owner.address, amount: 0n }))).code).to.equal(
      "INVALID_INPUT",
    );
    expect((await rejection(transfer({ ...offline, payer: owner, owner, mint, amount: 1n }))).code).to.equal("INVALID_INPUT");
  });

  it("errors are real Errors with a name, a code and the operation", () => {
    const error = new ConfidentialTransfersError("PENDING_BALANCE_LIMIT", "full", { operation: "transfer" });
    expect(error).to.be.instanceOf(Error);
    expect(error.name).to.equal("ConfidentialTransfersError");
    expect(isConfidentialTransfersError(error, "PENDING_BALANCE_LIMIT")).to.equal(true);
    expect(isConfidentialTransfersError(error, "INSUFFICIENT_FUNDS")).to.equal(false);
    expect(isConfidentialTransfersError(new Error("x"))).to.equal(false);
  });
});

describe("auditor report CSV", () => {
  it("writes one row per entry, formats amounts and quotes what needs quoting", async () => {
    const { confidentialActivityToCsv } = await import("../src/index");
    const a = (await generateKeyPairSigner()).address;
    const b = (await generateKeyPairSigner()).address;
    const csv = confidentialActivityToCsv(
      [
        { signature: "sig1" as never, slot: 5n, blockTime: new Date("2026-10-12T10:00:00Z"), kind: "transfer", fromToken: a, fromOwner: a, toToken: b, toOwner: b, amount: 12345n, decrypted: true },
        { signature: "sig2" as never, slot: 6n, blockTime: null, kind: "transfer", fromToken: a, fromOwner: null, toToken: b, toOwner: null, amount: null, decrypted: false, note: 'not encrypted, to "this" key' },
        { signature: "sig3" as never, slot: 7n, blockTime: null, kind: "deposit", fromToken: a, fromOwner: a, toToken: a, toOwner: a, amount: 5n, decrypted: false },
      ],
      { decimals: 2 },
    );
    const lines = csv.split("\r\n");
    expect(lines[1]).to.equal(`2026-10-12T10:00:00.000Z,5,sig1,transfer,${a},${a},${b},${b},12345,123.45,yes,`);
    expect(lines[2]).to.equal(`,6,sig2,transfer,,${a},,${b},,,no,"not encrypted, to ""this"" key"`);
    expect(lines[3]).to.contain(",5,0.05,no,");
    expect(lines[4]).to.equal("");
  });
});
