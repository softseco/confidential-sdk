// SPDX-License-Identifier: Apache-2.0
//
// Transfer-hook account resolution for confidential transfers.
//
// Token-2022 calls a mint's transfer hook on a confidential transfer exactly as it does on a public
// one, and the amount it passes is u64::MAX because the real amount is encrypted. The hook's own
// accounts are not part of the confidential-transfer instruction, so the client has to resolve them
// from the mint's ExtraAccountMetaList and append them, or the transfer fails with MissingAccount.
//
// The resolution rules are the ones in the SPL transfer-hook interface: a literal address, a PDA of
// the hook program, or a PDA of another account in the list, with seeds built from literals, the
// instruction data, an account key, or a slice of an account's data.
import {
  AccountRole,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS, fetchMint } from "@solana-program/token-2022";

/** Seed used for every mint's ExtraAccountMetaList account. */
export const EXTRA_ACCOUNT_METAS_SEED = "extra-account-metas";

/** Token-2022 invokes a hook for a confidential transfer with this amount, since the real one is encrypted. */
export const CONFIDENTIAL_TRANSFER_HOOK_AMOUNT = 0xffffffffffffffffn;

/** The transfer-hook interface's `Execute` instruction discriminator. */
const EXECUTE_DISCRIMINATOR = new Uint8Array([105, 37, 101, 197, 75, 251, 102, 26]);

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const META_HEADER = 16; // 8-byte type discriminator + u32 byte length + u32 entry count
const META_ENTRY = 35; // u8 discriminator + 32-byte address config + is_signer + is_writable

export type ResolvedAccount = { address: Address; role: AccountRole };

type Meta = { discriminator: number; addressConfig: Uint8Array; isWritable: boolean; isSigner: boolean };

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

function accountData(value: { data: readonly [string, string] | string } | null): Uint8Array | null {
  if (value == null) return null;
  const raw = Array.isArray(value.data) ? value.data[0] : (value.data as unknown as string);
  return new Uint8Array(getBase64Encoder().encode(raw));
}

async function fetchData(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<Uint8Array | null> {
  const { value } = await rpc.getAccountInfo(address, { encoding: "base64" }).send();
  return accountData(value as never);
}

/** The mint's transfer-hook program, or null when the mint has no hook. */
export async function getTransferHookProgram(
  rpc: Rpc<SolanaRpcApi>,
  mint: Address,
): Promise<Address | null> {
  const { data } = await fetchMint(rpc, mint);
  const extensions = (data as { extensions?: { __option: string; value?: unknown[] } }).extensions;
  const list = (extensions?.__option === "Some" ? extensions.value : []) ?? [];
  for (const extension of list as Array<Record<string, unknown>>) {
    if (extension.__kind !== "TransferHook") continue;
    const raw = extension.programId as Address | { __option: string; value?: Address };
    const programId =
      typeof raw === "string" ? raw : raw?.__option === "Some" ? (raw.value as Address) : null;
    if (programId == null || programId === SYSTEM_PROGRAM) return null;
    return programId;
  }
  return null;
}

/** The PDA holding a mint's ExtraAccountMetaList for a hook program. */
export async function findExtraAccountMetaListPda(
  mint: Address,
  hookProgram: Address,
): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: hookProgram,
    seeds: [new TextEncoder().encode(EXTRA_ACCOUNT_METAS_SEED), addressEncoder.encode(mint)],
  });
  return address;
}

function parseMetaList(data: Uint8Array): Meta[] {
  if (data.length < META_HEADER) return [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(12, true);
  const metas: Meta[] = [];
  for (let i = 0; i < count; i++) {
    const start = META_HEADER + i * META_ENTRY;
    if (start + META_ENTRY > data.length) break;
    metas.push({
      discriminator: data[start]!,
      addressConfig: data.subarray(start + 1, start + 33),
      isSigner: data[start + 33] === 1,
      isWritable: data[start + 34] === 1,
    });
  }
  return metas;
}

/** Build the seeds packed into an address config, in the SPL transfer-hook encoding. */
async function unpackSeeds(
  config: Uint8Array,
  previous: ResolvedAccount[],
  instructionData: Uint8Array,
  rpc: Rpc<SolanaRpcApi>,
): Promise<Uint8Array[]> {
  const seeds: Uint8Array[] = [];
  let i = 0;
  while (i < config.length) {
    const kind = config[i]!;
    if (kind === 0) break;
    if (kind === 1) {
      const length = config[i + 1]!;
      seeds.push(config.subarray(i + 2, i + 2 + length));
      i += 2 + length;
    } else if (kind === 2) {
      const [index, length] = [config[i + 1]!, config[i + 2]!];
      seeds.push(instructionData.subarray(index, index + length));
      i += 3;
    } else if (kind === 3) {
      const index = config[i + 1]!;
      const account = previous[index];
      if (account == null) throw new Error(`transfer hook seed refers to account ${index}, which is not in the list`);
      seeds.push(new Uint8Array(addressEncoder.encode(account.address)));
      i += 2;
    } else if (kind === 4) {
      const [accountIndex, dataIndex, length] = [config[i + 1]!, config[i + 2]!, config[i + 3]!];
      const account = previous[accountIndex];
      if (account == null) throw new Error(`transfer hook seed refers to account ${accountIndex}, which is not in the list`);
      const data = await fetchData(rpc, account.address);
      if (data == null) throw new Error(`transfer hook seed reads account ${account.address}, which does not exist`);
      seeds.push(data.subarray(dataIndex, dataIndex + length));
      i += 4;
    } else {
      throw new Error(`unsupported transfer hook seed type ${kind}`);
    }
  }
  return seeds;
}

async function resolveMeta(
  meta: Meta,
  previous: ResolvedAccount[],
  instructionData: Uint8Array,
  hookProgram: Address,
  rpc: Rpc<SolanaRpcApi>,
): Promise<ResolvedAccount> {
  const role = meta.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
  if (meta.discriminator === 0) {
    return { address: addressDecoder.decode(meta.addressConfig), role };
  }
  let programAddress = hookProgram;
  if (meta.discriminator !== 1) {
    const index = meta.discriminator - (1 << 7);
    const account = previous[index];
    if (account == null) throw new Error(`transfer hook PDA refers to program at index ${index}, which is not in the list`);
    programAddress = account.address;
  }
  const seeds = await unpackSeeds(meta.addressConfig, previous, instructionData, rpc);
  const [address] = await getProgramDerivedAddress({ programAddress, seeds });
  return { address, role };
}

export type ResolveTransferHookAccountsInput = {
  rpc: Rpc<SolanaRpcApi>;
  mint: Address;
  sourceToken: Address;
  destinationToken: Address;
  /** Owner of the source account — the transfer authority. */
  owner: Address;
  /** Amount the hook is told about. Confidential transfers always pass u64::MAX. */
  amount?: bigint;
  programAddress?: Address;
};

/**
 * Resolve the accounts a mint's transfer hook needs, in the order Token-2022 expects them appended
 * to a transfer instruction: the resolved extra accounts, then the hook program, then its metadata
 * account. Returns an empty array when the mint has no transfer hook.
 */
export async function resolveTransferHookAccounts(
  input: ResolveTransferHookAccountsInput,
): Promise<ResolvedAccount[]> {
  const hookProgram = await getTransferHookProgram(input.rpc, input.mint);
  if (hookProgram == null) return [];

  const metaListAddress = await findExtraAccountMetaListPda(input.mint, hookProgram);
  const metaListData = await fetchData(input.rpc, metaListAddress);
  if (metaListData == null) return [];

  // The account order the hook's Execute instruction sees, which seed indexes refer to.
  const resolved: ResolvedAccount[] = [
    { address: input.sourceToken, role: AccountRole.WRITABLE },
    { address: input.mint, role: AccountRole.READONLY },
    { address: input.destinationToken, role: AccountRole.WRITABLE },
    { address: input.owner, role: AccountRole.READONLY },
    { address: metaListAddress, role: AccountRole.READONLY },
  ];

  const amount = input.amount ?? CONFIDENTIAL_TRANSFER_HOOK_AMOUNT;
  const instructionData = new Uint8Array(16);
  instructionData.set(EXECUTE_DISCRIMINATOR, 0);
  new DataView(instructionData.buffer).setBigUint64(8, amount, true);

  for (const meta of parseMetaList(metaListData)) {
    resolved.push(await resolveMeta(meta, resolved, instructionData, hookProgram, input.rpc));
  }

  return [
    ...resolved.slice(5),
    { address: hookProgram, role: AccountRole.READONLY },
    { address: metaListAddress, role: AccountRole.READONLY },
  ];
}

export { TOKEN_2022_PROGRAM_ADDRESS };
