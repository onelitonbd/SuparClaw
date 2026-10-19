#!/usr/bin/env python3
"""Extract every link from the scraped OpenClaw docs and produce links.md + links.json."""
import json
import os
import re
from collections import Counter
from datetime import date

ROOT = "/root/docs/openclaw"
META = os.path.join(ROOT, "_meta")
LANG_PREFIXES = {
    "ar", "zh-TW", "zh-CN", "tr", "nl", "ja-JP", "hi", "fa", "es", "de",
    "vi", "th", "id", "ru", "pt-BR", "ko", "fr", "uk", "it", "pl", "sv",
}
ASSET_EXT = re.compile(
    r"\.(png|jpe?g|gif|svg|webp|ico|mp4|mov|webm|mp3|wav|pdf|zip|tar|gz|whl|tgz|patch|diff)([?#]|$)",
    re.I,
)
BARE_URL = re.compile(r"https?://[^\s<>\)\]\"'`]+")

md_links = Counter()      # normalized destination -> refs
ext_links = Counter()
mailto = Counter()
per_file = {}

def normalize(dest):
    """Return (kind, value) for a link destination."""
    dest = dest.strip()
    dest = dest.rstrip(".,;:!?")  # trailing punctuation from prose
    if not dest or dest.startswith("#"):
        return ("skip", dest)
    if dest.startswith("mailto:"):
        return ("mailto", dest)
    if dest.startswith("http://") or dest.startswith("https://"):
        for prefix in ("https://docs.openclaw.ai", "http://docs.openclaw.ai",
                       "https://www.docs.openclaw.ai"):
            if dest.startswith(prefix):
                return ("internal", dest[len(prefix):] or "/")
        return ("external", dest)
    if dest.startswith("/"):
        return ("internal", dest)
    if dest.startswith("//"):
        return ("external", "https:" + dest)
    # relative link (rare) - keep as-is, classified internal-relative
    return ("internal_relative", dest)

def scan(text, fname):
    found = set()
    # markdown links/images: [text](dest "title") and ![alt](dest)
    for m in re.finditer(r"!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)", text):
        found.add(m.group(1))
    # html href/src
    for m in re.finditer(r'(?:href|src)\s*=\s*["\']([^"\']+)["\']', text):
        found.add(m.group(1))
    # bare urls in prose
    for m in re.finditer(BARE_URL, text):
        found.add(m.group(0))
    return found

scanned = 0
for dirpath, dirnames, filenames in os.walk(ROOT):
    if "_meta" in dirpath.split(os.sep):
        continue
    for fn in sorted(filenames):
        if not fn.endswith(".md"):
            continue
        scanned += 1
        fp = os.path.join(dirpath, fn)
        rel = os.path.relpath(fp, ROOT)
        try:
            text = open(fp, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        links = scan(text, rel)
        if links:
            per_file[rel] = sorted(links)
        for dest in links:
            kind, val = normalize(dest)
            if kind == "internal":
                md_links[val] += 1
            elif kind == "external":
                ext_links[val] += 1
            elif kind == "mailto":
                mailto[val] += 1

def strip_anchor(p):
    return p.split("#", 1)[0]

def split_lang(p):
    seg = p.lstrip("/").split("/", 1)
    if seg and seg[0] in LANG_PREFIXES:
        return seg[0], "/" + (seg[1] if len(seg) > 1 else "")
    return None, p

internal_pages = Counter()
internal_assets = Counter()
internal_anchor_only = 0
translations = Counter()
external_rest = Counter()

for dest, count in md_links.items():
    base = strip_anchor(dest)
    if not base or base == "/" and dest.startswith("#"):
        internal_anchor_only += 1
        continue
    lang, rest = split_lang(base)
    if lang:
        translations[lang] += count
        continue
    if ASSET_EXT.search(base):
        internal_assets[base] += count
        continue
    internal_pages[rest or "/"] += count

# Which internal doc paths were not scraped into local files?
missing = []
for path in sorted(internal_pages):
    if path in ("", "/"):
        local = os.path.join(ROOT, "index.md")
    else:
        local = os.path.join(ROOT, path.lstrip("/") + ".md")
    if not os.path.exists(local):
        missing.append(path)

# Split external into site-family vs everything else
SITE_FAMILY = ("openclaw.ai", "openclaw.org", "docs.openclaw.ai")
family = Counter()
other = Counter()
github = Counter()
for url, count in ext_links.items():
    host = url.split("//", 1)[-1].split("/", 1)[0].lower()
    if host == "github.com":
        github[url] += count
    elif any(host == s or host.endswith("." + s) for s in SITE_FAMILY):
        family[url] += count
    else:
        other[url] += count

summary = {
    "scanned_files": scanned,
    "unique_internal_pages": len(internal_pages),
    "unique_internal_assets": len(internal_assets),
    "translation_links": sum(translations.values()),
    "translation_languages": len(translations),
    "unique_github_links": len(github),
    "unique_external_other": len(other),
    "unique_site_family": len(family),
    "unique_mailto": len(mailto),
    "internal_pages_not_local": len(missing),
}

os.makedirs(META, exist_ok=True)
with open(os.path.join(META, "links.json"), "w", encoding="utf-8") as f:
    json.dump({
        "summary": summary,
        "internal_pages": dict(sorted(internal_pages.items())),
        "internal_pages_not_local": missing,
        "internal_assets": dict(sorted(internal_assets.items())),
        "translation_links_per_language": dict(sorted(translations.items())),
        "external_other": dict(sorted(other.items())),
        "github": dict(sorted(github.items())),
        "site_family": dict(sorted(family.items())),
        "mailto": dict(sorted(mailto.items())),
        "per_file": per_file,
    }, f, indent=2, ensure_ascii=False)

# Complete GitHub link list goes to its own file (40k+ entries).
with open(os.path.join(META, "github-links.txt"), "w", encoding="utf-8") as f:
    for u in sorted(github):
        f.write(u + "\n")

L = []
L.append("# Extracted links — OpenClaw docs scrape")
L.append("")
L.append(f"> Auto-generated {date.today().isoformat()} from {scanned} scraped Markdown files.")
L.append("> Source: https://docs.openclaw.ai (agent-optimized .md exports).")
L.append("")
L.append("## Summary")
L.append("")
L.append(f"- Files scanned: **{scanned}**")
L.append(f"- Unique internal doc paths referenced: **{len(internal_pages)}**")
L.append(f"- Internal doc paths not present in the local scrape: **{len(missing)}**")
L.append(f"- Unique internal asset links: **{len(internal_assets)}**")
L.append(f"- Translation links (other languages): **{sum(translations.values())}** across {len(translations)} languages")
L.append(f"- Unique github.com links: **{len(github)}** (complete list in `github-links.txt`)")
L.append(f"- Unique external URLs (non-OpenClaw, non-GitHub): **{len(other)}**")
L.append(f"- Unique OpenClaw-family URLs (site/github/openclaw.org etc. filtered to family only): **{len(family)}**")
L.append(f"- mailto links: **{len(mailto)}**")
L.append("")
L.append("## Internal doc paths")
L.append("")
L.append("| Path | refs |")
L.append("|---|---:|")
for p, c in sorted(internal_pages.items()):
    L.append(f"| `{p}` | {c} |")
L.append("")
L.append("## Internal doc paths NOT in the local scrape")
L.append("")
if missing:
    for p in missing:
        L.append(f"- `{p}`")
else:
    L.append("_None — every referenced internal path exists locally._")
L.append("")
L.append("## Internal asset links (unique)")
L.append("")
for p, c in sorted(internal_assets.items()):
    L.append(f"- `{p}` ({c})")
L.append("")
L.append("## External URLs (github.com)")
L.append("")
L.append(f"All **{len(github)}** unique github.com links (mostly PR/commit references from release notes)")
L.append("are listed one per line in `github-links.txt` in this folder, and in `links.json` under `github`.")
L.append("")
L.append("## External URLs (everything else)")
L.append("")
for u, c in sorted(other.items()):
    L.append(f"- <{u}> ({c})")
L.append("")
L.append("## OpenClaw-family URLs")
L.append("")
for u, c in sorted(family.items()):
    L.append(f"- <{u}> ({c})")
L.append("")
if mailto:
    L.append("## mailto")
    L.append("")
    for u, c in sorted(mailto.items()):
        L.append(f"- `{u}` ({c})")
    L.append("")

with open(os.path.join(META, "links.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(L))

print(json.dumps(summary, indent=2))
print("missing sample:", missing[:20])
