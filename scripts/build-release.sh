#!/usr/bin/env bash
set -euo pipefail

: "${PACK_ZIP:?Set PACK_ZIP to the CurseForge export ZIP path}"
: "${BASE_URL:?Set BASE_URL to the public pack base URL, for example https://packs.example.com}"

OUT_DIR="${OUT_DIR:-dist-r2}"
CHANNEL="${CHANNEL:-stable}"
CACHE_MODS_DIR="${CACHE_MODS_DIR:-}"

cache_args=()
if [[ -n "$CACHE_MODS_DIR" ]]; then
  cache_args+=(--cache-mods "$CACHE_MODS_DIR")
fi

node src/cli.js build-release \
  --pack-zip "$PACK_ZIP" \
  --out "$OUT_DIR" \
  --base-url "$BASE_URL" \
  --channel "$CHANNEL" \
  "${cache_args[@]}"
