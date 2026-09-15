#!/usr/bin/env bash
set -euo pipefail

: "${R2_BUCKET:?Set R2_BUCKET to your Cloudflare R2 bucket name}"

node "$(dirname "$0")/sync-r2-directory.mjs" "${OUT_DIR:-dist-r2}" "$R2_BUCKET"
