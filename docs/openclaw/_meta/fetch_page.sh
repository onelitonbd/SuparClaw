#!/bin/bash
# Fetch a single docs.openclaw.ai page as Markdown into /root/docs/openclaw,
# mirroring the site's path structure. Usage: fetch_page.sh <full-url>
url="$1"
outdir="/root/SuparClaw/docs/openclaw"
rel="${url#https://docs.openclaw.ai}"
rel="${rel#/}"
rel="${rel%/}"
if [ -z "$rel" ]; then
  target="$outdir/index.md"
  mdurl="https://docs.openclaw.ai/index.md"
else
  target="$outdir/$rel.md"
  mdurl="https://docs.openclaw.ai/$rel.md"
fi
mkdir -p "$(dirname "$target")"
tmp="$target.part.$$"
if curl -sS -f --retry 3 --retry-delay 1 --connect-timeout 10 -m 90 "$mdurl" -o "$tmp"; then
  # sanity check: non-empty and not an HTML error page
  if [ -s "$tmp" ] && ! head -c 200 "$tmp" | grep -qi '<!DOCTYPE html>'; then
    mv "$tmp" "$target"
  else
    rm -f "$tmp"
    echo "$mdurl (bad content)" >> /tmp/opencode/fetch_failures.txt
  fi
else
  rm -f "$tmp"
  echo "$mdurl (fetch failed)" >> /tmp/opencode/fetch_failures.txt
fi
