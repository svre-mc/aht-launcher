#!/usr/bin/env bash
set -euo pipefail

: "${R2_BUCKET:?Set R2_BUCKET to your Cloudflare R2 bucket name}"

OUT_DIR="${OUT_DIR:-dist-r2}"

content_type() {
  case "$1" in
    *.json) printf 'application/json' ;;
    *.zip) printf 'application/zip' ;;
    *.jar) printf 'application/java-archive' ;;
    *.html) printf 'text/html; charset=utf-8' ;;
    *.txt) printf 'text/plain; charset=utf-8' ;;
    *) printf 'application/octet-stream' ;;
  esac
}

find "$OUT_DIR" -type f | while IFS= read -r file; do
  rel="${file#"$OUT_DIR"/}"
  type="$(content_type "$rel")"
  npx wrangler r2 object put "$R2_BUCKET/$rel" --file="$file" --content-type="$type"
done
