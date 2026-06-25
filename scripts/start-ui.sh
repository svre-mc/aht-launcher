#!/usr/bin/env bash
set -euo pipefail

CONFIG="${CONFIG:-launcher.config.json}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-7878}"

node src/web.js --config "$CONFIG" --host "$HOST" --port "$PORT"
