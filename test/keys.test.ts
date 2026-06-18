// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for confidential-transfer key derivation. No validator needed —
// this exercises the WASM ZK SDK directly: determinism, (owner, mint) binding,
// and the canonical Rust solana-zk-sdk derivation vector.
import { createKeyPairSignerFromPrivateKeyBytes, generateKeyPairSigner } from "@solana/kit";
import { expect } from "chai";

import { deriveAeKey, deriveElGamalKeypair, deriveElGamalKeypairForOwnerMint } from "../src/keys";

const RUST_VECTOR_PRIVATE_KEY = new Uint8Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32,
]);
const RUST_VECTOR_PUBLIC_SEED = new Uint8Array([
  32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8,
  7, 6, 5, 4, 3, 2, 1,
]);
const RUST_VECTOR_ELGAMAL_SECRET_KEY = new Uint8Array([
  241, 57, 101, 25, 81, 46, 182, 190, 48, 67, 70, 212, 112, 100, 196, 151, 81, 38, 121, 14, 125,
  101, 91, 57, 182, 241, 127, 250, 6, 41, 183, 15,
]);
const RUST_VECTOR_AE_KEY = new Uint8Array([
  227, 20, 117, 208, 41, 69, 224, 51, 180, 203, 193, 101, 242, 164, 192, 190,
]);

describe("confidential-transfer key derivation", () => {
  it("derives a 32-byte ElGamal secret key and a 16-byte AES key", async () => {
    const signer = await generateKeyPairSigner();
    const { secretKey } = await deriveElGamalKeypair({ signer });
    const aeKey = await deriveAeKey({ signer });
    expect(secretKey.length).to.equal(32);
    expect(aeKey.length).to.equal(16);
    expect(secretKey.every((b) => b === 0)).to.equal(false);
  });

  it("is deterministic for the same signer and seed", async () => {
    const signer = await generateKeyPairSigner();
    const publicSeed = new Uint8Array([1, 2, 3, 4]);
    const a = await deriveElGamalKeypair({ signer, publicSeed });
    const b = await deriveElGamalKeypair({ signer, publicSeed });
    expect(Array.from(a.secretKey)).to.deep.equal(Array.from(b.secretKey));
    expect(a.elgamalPubkey).to.equal(b.elgamalPubkey);
  });

  it("binds keys to (owner, mint)", async () => {
    const [signer, mintA, mintB] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const a = await deriveElGamalKeypairForOwnerMint({ signer, owner: signer.address, mint: mintA.address });
    const b = await deriveElGamalKeypairForOwnerMint({ signer, owner: signer.address, mint: mintB.address });
    expect(Array.from(a.secretKey)).to.not.deep.equal(Array.from(b.secretKey));
  });

  it("matches the Rust solana-zk-sdk derivation vector", async () => {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(RUST_VECTOR_PRIVATE_KEY);
    const elgamal = await deriveElGamalKeypair({ signer, publicSeed: RUST_VECTOR_PUBLIC_SEED });
    const aeKey = await deriveAeKey({ signer, publicSeed: RUST_VECTOR_PUBLIC_SEED });
    expect(Array.from(elgamal.secretKey)).to.deep.equal(Array.from(RUST_VECTOR_ELGAMAL_SECRET_KEY));
    expect(Array.from(aeKey)).to.deep.equal(Array.from(RUST_VECTOR_AE_KEY));
  });
});
