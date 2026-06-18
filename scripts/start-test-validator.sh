#!/usr/bin/env bash
#
# start-test-validator.sh — local Solana validator with Token-2022
# Confidential Transfers enabled (for SDK integration tests).
#
# Why this exists:
#   On Agave 3.1.x the ZK ElGamal Proof Program is turned OFF by the feature
#   gate "Disables zk-elgamal-proof program" (KILL_SWITCH below). The proof
#   program binary IS present in genesis, so deactivating that single feature
#   re-enables it for local testing. (Mainnet reactivation ships with Agave 4.0.)
#
# Usage:
#   Terminal 1:  ./scripts/start-test-validator.sh
#   Terminal 2:  npm test
#
set -euo pipefail

# Feature gate that disables the ZK ElGamal Proof Program (from `solana feature status`).
KILL_SWITCH="zkdoVwnSFnSLtGJG7irJPEYUpmb4i7sGMGcnN6T9rnC"

echo ">> Local validator with ZK ElGamal Proof Program ENABLED (kill-switch deactivated)"
exec solana-test-validator \
  --reset \
  --deactivate-feature "$KILL_SWITCH"

# If account configuration later fails because the bundled Token-2022 build has
# the confidential-transfer instructions stripped, load a CT-enabled build here:
#
#   exec solana-test-validator --reset \
#     --deactivate-feature "$KILL_SWITCH" \
#     --upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
#         ./programs/spl_token_2022.so <UPGRADE_AUTHORITY_PUBKEY>
