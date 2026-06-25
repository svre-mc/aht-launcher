#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${OUT_DIR:-dist-r2}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"

node src/cli.js serve-release --dir "$OUT_DIR" --host "$HOST" --port "$PORT"
