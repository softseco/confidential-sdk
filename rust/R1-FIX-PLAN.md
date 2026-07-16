# R1 — Fix the Rust `transfer` (context-state proofs)

**Status: FIXED in v1.0.1 — `tests/ct_integration.rs` passes (Alice 600, Bob 400).**

## Resolution (2026-07-15)

`transfer` now verifies the three ZK proofs into temporary context-state accounts and
sends a small transfer transaction referencing them, then closes the accounts
(best-effort even on a failed transfer) to reclaim rent. Two corrections to the plan
below, learned from the actual spl-token-client 0.19.0 source (crates.io tarball,
sha256 matching Cargo.lock) and the spl-token-cli 5.6.1 implementation:

1. **The split-proofs API named below does not exist in 0.19.0.**
   `confidential_transfer_transfer_with_split_proofs` / `TransferSplitContextStateAccounts`
   are from an older client. The current flow is:
   `TransferAccountInfo::new(..)` → `generate_split_transfer_proof_data(..)` →
   `confidential_transfer_create_context_state_account(..)` ×3 (range proof with
   `split_account_creation_and_proof_verification = true`, the other two `false`) →
   `confidential_transfer_transfer(.., Some(&equality_pk), Some(&ProofAccountWithCiphertext),
   Some(&range_pk), Some(account_info), ..)` → `confidential_transfer_close_context_state_account` ×3.
2. **Compute budget:** `VerifyBatchedRangeProofU128` costs exactly 200_000 CU (agave 4.0.x),
   the default single-instruction budget. The `Token` client is therefore configured with
   `ComputeUnitLimit::Simulated`, like the official CLI.

Also fixed: the test's `airdrop` helper no longer reports success when the airdrop is
accepted but never credited (it now retries and fails loudly — a stalled validator
previously surfaced as a confusing `AccountNotFound` at mint creation).

---

Original plan (kept for reference):

## The bug

`transfer` in `src/operations.rs` generates the three ZK proofs **inline**, which makes the
transfer transaction **~3308 bytes** — well over Solana's **1232-byte** limit — so it fails for any
real transfer. The rest of the crate (`configure_account`, `deposit`, `apply_pending_balance`,
`decrypt_balance`, auditor utilities) works.

Proven by the gated integration test `tests/ct_integration.rs`:
- Setup passes: create CT mint → configure Alice & Bob → mint_to → deposit → apply.
- Fails at step `[4] TRANSFER` with:
  `base64 encoded ... VersionedTransaction too large: 3308 bytes (max: encoded/raw 1644/1232)`.

## How to run the test

```bash
# 1. point the CLI at localhost
solana config set --url http://127.0.0.1:8899

# 2. start the CT validator (ZK ElGamal Proof Program + client-matching Token-2022), in background
cd ~/confidential-sdk
TOKEN_2022_SO=~/token-2022-src/target/deploy/spl_token_2022.so \
  nohup bash scripts/start-test-validator.sh > /tmp/ct-validator.log 2>&1 &
sleep 14 && solana cluster-version        # confirm it's alive

# 3. run the gated integration test
cd ~/confidential-sdk/rust
CT_LOCAL_PROGRAM=1 cargo test --test ct_integration -- --nocapture
```

## The fix

Port `transfer` from inline proofs to **context-state proof accounts**, mirroring the TypeScript
SDK (`src/internal/confidentialTransferProof.ts`), which already does this and passes its tests:

1. Create three context-state accounts (equality, ciphertext-validity, range).
2. Generate each proof and verify it into its context-state account (setup transactions).
3. Run the transfer referencing the three accounts (now small — no inline proofs).
4. Close the accounts to reclaim rent.

Use `spl-token-client`'s split-proofs API:
- `Token::confidential_transfer_transfer_with_split_proofs(...)`
- `TransferSplitContextStateAccounts { equality_proof, ciphertext_validity_proof, range_proof,
  authority, no_op_on_uninitialized_split_context_state, close_split_context_state_accounts }`
- `CloseSplitContextStateAccounts { .. }` for auto-close on execution.

**Get the exact signatures first** — `web_fetch` on docs.rs returned empty, so use **Claude in
Chrome** to render
`docs.rs/spl-token-client/0.19.0/spl_token_client/token/struct.Token.html`
(and the two structs above), **or** read the official `spl-token-cli` confidential-transfer command
source — it performs exactly this split-proofs flow. Grounding on the real API avoids blind
iteration.

## Done when

`tests/ct_integration.rs` passes green (Alice 600, Bob 400). Then:
1. commit the test + the fixed `transfer`,
2. bump the crate version + republish to crates.io,
3. update `README.md` / `operations.rs` docs (remove the "known broken" note) + this file.

## Toolchain (already working)

anchor 0.31 · solana/agave 4.0.2 · rustc 1.95 · the crate deps are pinned with `=` to the
spl-token-cli set (see `Cargo.toml`). The integration test compiles cleanly.
