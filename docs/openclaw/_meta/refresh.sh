#!/usr/bin/env bash
# Re-scrape the English OpenClaw docs into this folder.
# Usage: refresh.sh   (run from anywhere; writes into the folder containing this script's parent)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(dirname "$HERE")"
META="$HERE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[1/3] Fetching sitemap and building English URL list..."
curl -sS https://docs.openclaw.ai/sitemap.xml -o "$TMP/sitemap.xml"
grep -o '<loc>[^<]*</loc>' "$TMP/sitemap.xml" | sed 's/<[^>]*>//g' > "$TMP/all_urls.txt"
# Strip translation-prefixed URLs (ar, de, es, ...) - keep English (default) docs only.
LANG_RE='/(ar|zh-TW|zh-CN|tr|nl|ja-JP|hi|fa|es|de|vi|th|id|ru|pt-BR|ko|fr|uk|it|pl|sv)(/|$)'
grep -vE "$LANG_RE" "$TMP/all_urls.txt" > "$META/en_urls.txt"
sort -u -o "$META/en_urls.txt" "$META/en_urls.txt"
echo "      $(wc -l < "$META/en_urls.txt") English pages found"

echo "[2/3] Fetching each page as Markdown (parallel)..."
export OUT META TMP
fetch_one() {
  url="$1"
  rel="${url#https://docs.openclaw.ai}"; rel="${rel#/}"; rel="${rel%/}"
  if [ -z "$rel" ]; then tgt="$OUT/index.md"; md="https://docs.openclaw.ai/index.md";
  else tgt="$OUT/$rel.md"; md="https://docs.openclaw.ai/$rel.md"; fi
  mkdir -p "$(dirname "$tgt")"
  if curl -sS -f --retry 3 --retry-delay 1 --connect-timeout 10 -m 90 "$md" -o "$tgt.tmp"; then
    if [ -s "$tgt.tmp" ] && ! head -c 200 "$tgt.tmp" | grep -qi '<!DOCTYPE html>'; then mv "$tgt.tmp" "$tgt"; else rm -f "$tgt.tmp"; echo "$md (bad)" >> "$TMP/failures.txt"; fi
  else rm -f "$tgt.tmp"; echo "$md (fail)" >> "$TMP/failures.txt"; fi
}
export -f fetch_one
xargs -a "$META/en_urls.txt" -P 8 -n 1 -I{} bash -c 'fetch_one "$@"' _ {}
: > "$META/fetch_failures.txt"
if [ -f "$TMP/failures.txt" ]; then cp "$TMP/failures.txt" "$META/fetch_failures.txt"; fi
echo "      failures: $(wc -l < "$META/fetch_failures.txt")"

echo "[3/3] Refreshing meta files (llms.txt, llms-full.txt, sitemap)..."
curl -sS https://docs.openclaw.ai/llms.txt -o "$META/llms.txt"
curl -sS https://docs.openclaw.ai/llms-full.txt -o "$META/llms-full.txt"
cp "$TMP/sitemap.xml" "$META/sitemap.xml"

echo "Done. Docs: $OUT"
