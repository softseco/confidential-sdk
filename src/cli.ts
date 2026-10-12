// SPDX-License-Identifier: Apache-2.0
//
// Command line for auditors:
//
//   npx @softseco/confidential-transfers audit-report --mint <address> --keypair <auditor wallet.json> \
//       --rpc <url> [--out report.csv] [--since 2026-10-01] [--until 2026-11-01]
//
// Writes every deposit, confidential transfer and withdraw of the mint as CSV, with the
// transferred amounts decrypted with the auditor key derived from the given wallet.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { address, createKeyPairSignerFromBytes, createSolanaRpc } from "@solana/kit";

import { deriveAuditorElgamalKeypair, getAuditorElgamalPubkey } from "./auditor";
import { confidentialActivityToCsv, listConfidentialActivity, readMint } from "./auditorReport";

const USAGE = `Usage:
  confidential-transfers audit-report --mint <address> --keypair <auditor wallet keypair.json> --rpc <url>
      [--out <file.csv>] [--since <date>] [--until <date>] [--max <transactions>] [--concurrency <n>]
      [--skip-auditor-key-check]

  Lists every deposit, confidential transfer and withdraw of the mint, with the amounts of the
  confidential transfers decrypted with the auditor key, as CSV (to --out, or to standard output).

  --keypair   the auditor's Solana wallet keypair file (the JSON array the Solana CLI writes); the
              auditor's ElGamal key is derived from it, as deriveAuditorElgamalKeypair does
  --rpc       RPC endpoint (or set RPC_URL); it must serve getSignaturesForAddress and getTransaction
  --since, --until   ISO dates or times, e.g. 2026-10-01 or 2026-10-01T12:00:00Z (UTC)
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "audit-report") {
    process.stderr.write(USAGE);
    return command === undefined || command === "--help" || command === "-h" ? 0 : 1;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      mint: { type: "string" },
      keypair: { type: "string" },
      rpc: { type: "string" },
      out: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      max: { type: "string" },
      concurrency: { type: "string" },
      "skip-auditor-key-check": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stderr.write(USAGE);
    return 0;
  }
  const rpcUrl = values.rpc ?? process.env.RPC_URL;
  if (!values.mint || !values.keypair || !rpcUrl) {
    process.stderr.write(`--mint, --keypair and --rpc (or RPC_URL) are required.\n\n${USAGE}`);
    return 1;
  }
  const date = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`--${name}: not a date: ${value}`);
    return d;
  };

  const rpc = createSolanaRpc(rpcUrl);
  const mint = address(values.mint);
  const wallet = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(values.keypair, "utf8"))));
  const auditorKeypair = await deriveAuditorElgamalKeypair(wallet);
  // The origin only: an API key in the query string is never printed.
  process.stderr.write(`RPC:         ${new URL(rpcUrl).origin}\nmint:        ${mint}\nauditor key: ${getAuditorElgamalPubkey(auditorKeypair)}\n`);

  const decimals = (await readMint(rpc, mint, "audit-report")).data.decimals;
  const activity = await listConfidentialActivity({
    rpc,
    mint,
    auditorKeypair,
    since: date(values.since, "since"),
    until: date(values.until, "until"),
    maxTransactions: values.max === undefined ? undefined : Number(values.max),
    concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
    skipAuditorKeyCheck: values["skip-auditor-key-check"],
  });
  const csv = confidentialActivityToCsv(activity, { decimals });

  const count = (kind: string) => activity.filter((a) => a.kind === kind).length;
  const unreadable = activity.filter((a) => a.amount === null).length;
  process.stderr.write(
    `found:       ${count("deposit")} deposits, ${count("transfer") + count("transfer-with-fee")} confidential transfers, ${count("withdraw")} withdraws` +
      (unreadable ? ` (${unreadable} amounts could not be decrypted; see the note column)` : "") +
      "\n",
  );
  if (values.out) {
    writeFileSync(values.out, csv);
    process.stderr.write(`written:     ${values.out}\n`);
  } else {
    process.stdout.write(csv);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
