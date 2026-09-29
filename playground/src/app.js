// SPDX-License-Identifier: Apache-2.0
//
// Confidential Transfers SDK — playground. The whole lifecycle of a Token-2022 confidential transfer,
// run in the browser against Solana devnet with throwaway keys:
//
//   fund -> create a confidential mint -> deposit -> transfer -> decrypt -> withdraw
//
// Every call below is the published SDK (@softseco/confidential-transfers) as an app would use it.
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  lamports,
  none,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  some,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  findAssociatedTokenPda,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from "@solana-program/token-2022";
import {
  applyPendingBalance,
  configureAccount,
  decryptBalance,
  decryptTransferAmountAsAuditor,
  deposit,
  deriveAuditorElgamalKeypair,
  getAuditorElgamalPubkey,
  transfer,
  withdraw,
} from "@softseco/confidential-transfers";

import { initZk } from "./zk-shim.js";
import { createPollingSubscriptions } from "./polling.js";

// ---------------------------------------------------------------- setup

const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);
const STORE = "softseco-ct-playground-v1";
const MIN_SOL = 50_000_000n; // 0.05 SOL covers every step with room to spare

const params = new URLSearchParams(location.search);
const customRpc = params.get("rpc");
const RPC_URL = customRpc && /^https:\/\//.test(customRpc) ? customRpc : "https://api.devnet.solana.com";

// The public endpoint answers 429 when it is busy; wait the way it asks instead of failing.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await realFetch(input, init);
    if (res.status !== 429 || attempt >= 6) return res;
    const wait = (Number(res.headers.get("retry-after") ?? 2) + attempt) * 1000;
    await new Promise((r) => setTimeout(r, wait));
  }
};

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createPollingSubscriptions(rpc);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const fmt = (units) => {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const whole = v / UNIT;
  const cents = (v % UNIT) / 10n ** BigInt(DECIMALS - 2);
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
};
const sol = (lam) => (Number(lam) / 1e9).toFixed(3);
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const tx = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const acct = (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
// An error meant for the visitor as written, not a chain failure.
const hint = (text) => Object.assign(new Error(text), { hint: true });
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

// ---------------------------------------------------------------- state

function load() {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    /* private mode: the run still works, it just will not survive a reload */
  }
}
const freshSeeds = () => ({
  you: hex(crypto.getRandomValues(new Uint8Array(32))),
  bob: hex(crypto.getRandomValues(new Uint8Array(32))),
  auditor: hex(crypto.getRandomValues(new Uint8Array(32))),
});

const fresh = () => ({ seeds: freshSeeds(), done: 0, mint: null, bobMint: null, sent: null, signatures: [] });
let state = load() ?? fresh();
let keys; // { you, bob, auditor } — kit signers
let auditorKeypair; // ElGamal keypair derived from the auditor's wallet
let busy = false;

async function signers() {
  const make = (h) => createKeyPairSignerFromPrivateKeyBytes(unhex(h));
  const [you, bob, auditor] = await Promise.all([make(state.seeds.you), make(state.seeds.bob), make(state.seeds.auditor)]);
  return { you, bob, auditor };
}

// ---------------------------------------------------------------- chain helpers

async function send(instructions) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(keys.you, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signed);
  await sendAndConfirm(signed, { commitment: "confirmed" });
  return getSignatureFromTransaction(signed);
}

const ataOf = async (owner) =>
  (await findAssociatedTokenPda({ owner, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, mint: address(state.mint) }))[0];

async function publicBalance(owner) {
  try {
    const { value } = await rpc.getTokenAccountBalance(await ataOf(owner)).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

const confidentialBalance = (owner) => decryptBalance({ rpc, owner, mint: address(state.mint) });

async function solBalance() {
  const { value } = await rpc.getBalance(keys.you.address).send();
  return value;
}

// ---------------------------------------------------------------- the steps

const sdk = { rpc, rpcSubscriptions };

const STEPS = {
  1: async () => {
    say(1, "Asking the devnet faucet for 1 SOL…");
    try {
      await rpc.requestAirdrop(keys.you.address, lamports(1_000_000_000n)).send();
    } catch (err) {
      throw new Error("faucet");
    }
    say(1, "Airdrop sent. Waiting for it to land…");
    for (let i = 0; i < 30; i++) {
      if ((await solBalance()) >= MIN_SOL) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("faucet");
  },

  2: async () => {
    say(2, "Creating a Token-2022 mint with the confidential-transfer extension…");
    const mint = await generateKeyPairSigner();
    const auditorElgamalPubkey = getAuditorElgamalPubkey(auditorKeypair);
    const ext = [
      extension("ConfidentialTransferMint", {
        authority: some(keys.you.address),
        autoApproveNewAccounts: true,
        auditorElgamalPubkey: some(auditorElgamalPubkey),
      }),
    ];
    const space = BigInt(getMintSize(ext));
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    const created = await send([
      getCreateAccountInstruction({
        payer: keys.you,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getInitializeConfidentialTransferMintInstruction({
        mint: mint.address,
        authority: some(keys.you.address),
        autoApproveNewAccounts: true,
        auditorElgamalPubkey: some(auditorElgamalPubkey),
      }),
      getInitializeMint2Instruction({
        mint: mint.address,
        decimals: DECIMALS,
        mintAuthority: keys.you.address,
        freezeAuthority: none(),
      }),
    ]);
    state.mint = mint.address;
    save();

    say(2, "Configuring your token account for confidential transfers…");
    await configureAccount({ ...sdk, payer: keys.you, owner: keys.you, mint: mint.address });

    say(2, "Minting 1,000 public test dollars to you…");
    await send([
      getMintToInstruction({
        mint: mint.address,
        token: await ataOf(keys.you.address),
        mintAuthority: keys.you,
        amount: 1000n * UNIT,
      }),
    ]);
    out(2, `
      <div class="kv"><span>Mint</span><a href="${acct(mint.address)}" target="_blank" rel="noopener">${short(mint.address)}</a></div>
      <div class="kv"><span>Created in</span><a href="${tx(created)}" target="_blank" rel="noopener">this transaction</a></div>
      <div class="kv"><span>Auditor</span><b>${short(keys.auditor.address)}</b><em>designated on the mint</em></div>`);
  },

  3: async () => {
    const amount = 100n * UNIT;
    say(3, "Depositing 100 into your pending confidential balance…");
    const dep = await deposit({ ...sdk, payer: keys.you, owner: keys.you, mint: address(state.mint), amount, decimals: DECIMALS });
    say(3, "Applying the pending balance, so it becomes available to spend…");
    await applyPendingBalance({ ...sdk, payer: keys.you, owner: keys.you, mint: address(state.mint) });
    const [pub, conf] = await Promise.all([publicBalance(keys.you.address), confidentialBalance(keys.you)]);
    out(3, `
      <div class="kv"><span>Public</span><b>${fmt(pub)}</b></div>
      <div class="kv"><span>Confidential</span><b>${fmt(conf)}</b><em>decrypted with your key</em></div>
      <div class="kv"><span>Deposit</span><a href="${tx(dep.signature)}" target="_blank" rel="noopener">transaction</a></div>`);
  },

  4: async () => {
    const input = $("#amount");
    const whole = Number(input.value);
    if (!Number.isFinite(whole) || whole <= 0) throw hint("Enter an amount above zero.");
    const amount = BigInt(Math.round(whole * 100)) * (UNIT / 100n);
    if (!state.sent) {
      const available = await confidentialBalance(keys.you);
      if (amount > available) throw hint(`You have ${fmt(available)} in your confidential balance.`);
    }

    // A retry after a failure part-way through must not configure Bob twice or send twice.
    if (state.bobMint !== state.mint) {
      say(4, "Configuring Bob's account (you pay the rent; Bob signs for his keys)…");
      await configureAccount({ ...sdk, payer: keys.you, owner: keys.bob, mint: address(state.mint) });
      state.bobMint = state.mint;
      save();
    }
    if (!state.sent) {
      say(4, "Building the zero-knowledge proofs and sending the transfer — this takes a few transactions…");
      const { signatures } = await transfer({
        ...sdk,
        payer: keys.you,
        owner: keys.you,
        mint: address(state.mint),
        destinationOwner: keys.bob.address,
        amount,
        auditorElgamalPubkey: getAuditorElgamalPubkey(auditorKeypair),
      });
      state.signatures = signatures.map(String);
      state.sent = amount.toString();
      save();
    }
    say(4, "Bob applies his pending balance…");
    await applyPendingBalance({ ...sdk, payer: keys.you, owner: keys.bob, mint: address(state.mint) });
    out(4, `
      <p class="note">Open any of these in the explorer. You will find the sender, the recipient and the proofs — and no amount.</p>
      <ul class="links">${state.signatures.map((s, i) => `<li><a href="${tx(s)}" target="_blank" rel="noopener">transaction ${i + 1} of ${state.signatures.length}</a></li>`).join("")}</ul>`);
  },

  5: async () => {
    say(5, "Decrypting with each key…");
    const [mine, bobs] = await Promise.all([confidentialBalance(keys.you), confidentialBalance(keys.bob)]);
    let seen = null;
    for (const s of state.signatures) {
      try {
        seen = await decryptTransferAmountAsAuditor({ rpc, signature: s, auditorKeypair });
        break;
      } catch {
        /* the transfer spans several transactions; only one carries the ciphertext */
      }
    }
    out(5, `
      <div class="who ok"><b>You</b><span>your confidential balance is <strong>${fmt(mine)}</strong></span></div>
      <div class="who ok"><b>Bob</b><span>his confidential balance is <strong>${fmt(bobs)}</strong></span></div>
      <div class="who ok"><b>The auditor</b><span>the transfer was <strong>${seen === null ? "not found" : fmt(seen)}</strong></span></div>
      <div class="who no"><b>Everyone else</b><span>ciphertext — <a href="${tx(state.signatures.at(-1) ?? "")}" target="_blank" rel="noopener">see for yourself</a></span></div>`);
  },

  6: async () => {
    const amount = await confidentialBalance(keys.bob);
    if (amount === 0n) throw hint("Bob's confidential balance is empty.");
    say(6, `Bob withdraws ${fmt(amount)} to his public balance — an equality proof and a range proof…`);
    const { signatures } = await withdraw({ ...sdk, payer: keys.you, owner: keys.bob, mint: address(state.mint), amount, decimals: DECIMALS });
    const [pub, conf] = await Promise.all([publicBalance(keys.bob.address), confidentialBalance(keys.bob)]);
    out(6, `
      <div class="kv"><span>Bob public</span><b>${fmt(pub)}</b></div>
      <div class="kv"><span>Bob confidential</span><b>${fmt(conf)}</b></div>
      <div class="kv"><span>Withdraw</span><a href="${tx(signatures.at(-1))}" target="_blank" rel="noopener">transaction</a></div>
      <p class="note done">That is the whole lifecycle: configure, deposit, apply, transfer, decrypt, withdraw.</p>`);
  },
};

// ---------------------------------------------------------------- UI

function say(n, text, kind = "") {
  const el = $(`.step[data-step="${n}"] .status`);
  el.className = `status ${kind}`;
  el.textContent = text;
}
function out(n, html) {
  $(`.step[data-step="${n}"] .out`).innerHTML = html;
}

function paint() {
  for (const el of $$(".step")) {
    const n = Number(el.dataset.step);
    el.dataset.state = n <= state.done ? "done" : n === state.done + 1 ? "ready" : "locked";
    const button = $("button[data-run]", el);
    if (button) button.disabled = busy || n !== state.done + 1;
  }
  $("#restart").disabled = busy;
  $("#finale").hidden = state.done < 6;
}

async function refreshSide() {
  if (!keys) return;
  $("#addr-you").textContent = short(keys.you.address);
  $("#addr-you").href = acct(keys.you.address);
  $("#addr-bob").textContent = short(keys.bob.address);
  $("#addr-bob").href = acct(keys.bob.address);
  $("#addr-auditor").textContent = short(keys.auditor.address);
  $("#addr-auditor").href = acct(keys.auditor.address);
  try {
    $("#sol").textContent = sol(await solBalance());
  } catch {
    $("#sol").textContent = "—";
  }
  if (!state.mint || state.done < 2) return;
  const rows = [
    ["#you-pub", () => publicBalance(keys.you.address)],
    ["#you-conf", () => confidentialBalance(keys.you)],
    ["#bob-pub", () => publicBalance(keys.bob.address)],
    ["#bob-conf", () => (state.done >= 4 ? confidentialBalance(keys.bob) : Promise.resolve(0n))],
  ];
  await Promise.all(rows.map(async ([sel, read]) => {
    try {
      $(sel).textContent = fmt(await read());
    } catch {
      $(sel).textContent = "—";
    }
  }));
}

// kit's browser build ships numeric error codes only; name the few a visitor can act on.
const NO_SOL = new Set([7050003, 7050005, 7050031, 4615006]); // account not found, fee, rent, insufficient funds
const EXPIRED = new Set([1, 7050008]); // block height exceeded, blockhash not found
const UNREACHABLE = new Set([8100002, -32005]); // HTTP error, node unhealthy

function explain(err) {
  const text = String(err?.message ?? err);
  if (err?.hint) return text;
  if (text === "faucet") {
    return "The devnet faucet said no — it limits requests. Copy your address above and get SOL at faucet.solana.com (choose devnet), or send some from a devnet wallet. This step completes by itself when it arrives.";
  }
  const codes = [];
  const logs = [];
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (e.context?.__code !== undefined) codes.push(Number(e.context.__code));
    if (Array.isArray(e.context?.logs)) logs.push(...e.context.logs);
    if (e.message) logs.push(e.message);
  }
  const all = [text, ...logs].join("\n");
  if (codes.some((c) => NO_SOL.has(c)) || /insufficient (funds|lamports)|InsufficientFunds/i.test(all)) {
    return "Not enough devnet SOL for this step. Top up the address above and press the button again.";
  }
  if (codes.some((c) => EXPIRED.has(c))) return "Devnet was slow and the transaction expired. Press the button again.";
  if (codes.some((c) => UNREACHABLE.has(c)) || /Failed to fetch|NetworkError|network/i.test(all)) {
    return "Devnet did not answer. Wait a moment and press the button again.";
  }
  const line = text.split("\n--- program logs ---")[0];
  const code = codes[0] !== undefined ? ` (Solana error ${codes[0]})` : "";
  return `${/^Solana error/.test(line) ? "Devnet rejected the transaction" : line.slice(0, 240)}${code}. Press the button again; if it keeps failing, start over with new keys.`;
}

async function run(n) {
  if (busy) return;
  busy = true;
  paint();
  try {
    await STEPS[n]();
    state.done = Math.max(state.done, n);
    save();
    say(n, "Done.", "ok");
  } catch (err) {
    console.error(err);
    say(n, explain(err), "err");
  } finally {
    busy = false;
    paint();
    refreshSide();
  }
}

// Step 1 also completes on its own when SOL arrives from somewhere else (faucet site, a wallet).
async function watchFunding() {
  while (state.done < 1) {
    try {
      const bal = await solBalance();
      $("#sol").textContent = sol(bal);
      if (bal >= MIN_SOL && !busy) {
        state.done = 1;
        save();
        say(1, "Funded.", "ok");
        paint();
        return;
      }
    } catch {
      /* try again on the next tick */
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function restart() {
  if (busy) return;
  state = fresh();
  save();
  location.reload();
}

async function main() {
  $("#rpc").textContent = new URL(RPC_URL).host;
  $$("button[data-run]").forEach((b) => b.addEventListener("click", () => run(Number(b.dataset.run))));
  $("#restart").addEventListener("click", restart);
  $("#copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(keys.you.address);
      $("#copy").textContent = "Copied";
      setTimeout(() => ($("#copy").textContent = "Copy address"), 1500);
    } catch {
      /* clipboard blocked: the address is still on screen */
    }
  });
  paint();

  try {
    await generateKeyPairSigner();
  } catch {
    banner("This browser cannot make Ed25519 keys (WebCrypto). Use a recent Chrome, Edge, Firefox or Safari.");
    return;
  }
  try {
    await initZk(new URL("./zk_sdk_bg.wasm", import.meta.url));
  } catch (err) {
    console.error(err);
    banner("The zero-knowledge module did not load. Reload the page.");
    return;
  }
  keys = await signers();
  auditorKeypair = await deriveAuditorElgamalKeypair(keys.auditor);
  $("#ready").hidden = true;
  if (state.done >= 1) say(1, "Funded.", "ok");
  for (let n = 2; n <= state.done; n++) say(n, "Done.", "ok");
  paint();
  refreshSide();
  watchFunding();
}

function banner(text) {
  const el = $("#ready");
  el.hidden = false;
  el.classList.add("err");
  el.textContent = text;
}

main();
