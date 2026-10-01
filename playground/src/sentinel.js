// SPDX-License-Identifier: Apache-2.0
//
// The three Sentinel instructions the playground needs, built with @solana/kit. They are the same
// instructions @softseco/sentinel sends from Node (initializeExtraAccountMetaList, initializePolicy,
// addToBlocklist); that package is built on Anchor and web3.js, so the page encodes them directly.
// Discriminators and account order come from the Sentinel 2.0.2 IDL.
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
} from "@solana/kit";

/** Sentinel 2.0.2 on devnet. */
export const SENTINEL_PROGRAM_ADDRESS = address("5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD");
const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

const DISCRIMINATOR = {
  initializeExtraAccountMetaList: [92, 197, 174, 197, 41, 124, 19, 3],
  initializePolicy: [9, 186, 86, 225, 129, 162, 231, 56],
  addToBlocklist: [201, 138, 75, 216, 252, 201, 26, 106],
};

const addressBytes = getAddressEncoder();
const utf8 = (s) => new TextEncoder().encode(s);

async function pda(seeds) {
  const [found] = await getProgramDerivedAddress({ programAddress: SENTINEL_PROGRAM_ADDRESS, seeds });
  return found;
}

export const policyPda = (mint) => pda([utf8("policy"), addressBytes.encode(mint)]);
export const metaListPda = (mint) => pda([utf8("extra-account-metas"), addressBytes.encode(mint)]);
export const blockEntryPda = (mint, wallet) => pda([utf8("block"), addressBytes.encode(mint), addressBytes.encode(wallet)]);

const signerMeta = (signer) => ({ address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer });
const writable = (a) => ({ address: a, role: AccountRole.WRITABLE });
const readonly = (a) => ({ address: a, role: AccountRole.READONLY });

function data(name, ...parts) {
  const bytes = [...DISCRIMINATOR[name]];
  for (const p of parts) bytes.push(...p);
  return new Uint8Array(bytes);
}
const bool = (b) => [b ? 1 : 0];
const u64 = (n) => [...getU64Encoder().encode(BigInt(n))];

/** The accounts Token-2022 passes to the hook on every transfer. The payer must be the mint authority. */
export async function getInitializeExtraAccountMetaListInstruction({ payer, mint }) {
  return {
    programAddress: SENTINEL_PROGRAM_ADDRESS,
    accounts: [signerMeta(payer), writable(await metaListPda(mint)), readonly(mint), readonly(SYSTEM_PROGRAM_ADDRESS)],
    data: data("initializeExtraAccountMetaList"),
  };
}

/** The mint's policy. The authority must be the mint authority and becomes the policy authority. */
export async function getInitializePolicyInstruction({ authority, mint, allowlist, blocklist, maxTransferAmount, allowConfidential }) {
  return {
    programAddress: SENTINEL_PROGRAM_ADDRESS,
    accounts: [signerMeta(authority), readonly(mint), writable(await policyPda(mint)), readonly(SYSTEM_PROGRAM_ADDRESS)],
    data: data("initializePolicy", bool(allowlist), bool(blocklist), u64(maxTransferAmount), bool(allowConfidential)),
  };
}

/** Put a wallet on the mint's blocklist: it can neither send nor receive this token. */
export async function getAddToBlocklistInstruction({ authority, mint, wallet }) {
  return {
    programAddress: SENTINEL_PROGRAM_ADDRESS,
    accounts: [
      signerMeta(authority),
      readonly(mint),
      readonly(await policyPda(mint)),
      readonly(wallet),
      writable(await blockEntryPda(mint, wallet)),
      readonly(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: data("addToBlocklist"),
  };
}
