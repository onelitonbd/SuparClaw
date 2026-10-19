# OpenClaw docs — local mirror

Complete local mirror of the **OpenClaw documentation website** for offline reading and context.

- **Source:** https://docs.openclaw.ai
- **Scraped:** 2026-10-19
- **Pages:** 1,403 Markdown files (every English page: full sitemap + 6 live pages the sitemap missed)
- **Size:** ≈31 MB of page content (plus a 27 MB single-file bundle in `_meta/`)
- **Fetch failures:** 0
- **Method:** the site serves agent-optimized Markdown — appending `.md` to any page URL returns clean Markdown (robots.txt allows this). Pages were fetched from the site's `sitemap.xml`.

## Layout

The folder mirrors the site's URL structure exactly — `https://docs.openclaw.ai/channels/discord/setup` → `channels/discord/setup.md`.

- `index.md` — homepage overview
- `start/`, `install/`, `channels/`, `concepts/`, `tools/`, `cli/`, `gateway/`, `providers/`, `plugins/`, `platforms/`, `nodes/`, `web/`, `automation/`, `security/`, `help/`, `releases/`, `reference/`, `clawhub/`, `ci/` — the documentation sections
- Root-level pages: `agent-runtime-architecture.md`, `auth-credential-semantics.md`, `date-time.md`, `docs_map.md`, `logging.md`, `network.md`, `openclaw-agent-runtime.md`, `prose.md`, `vps.md`, `security.md`, etc.

Every file preserves the original frontmatter (`title`, `summary`, `read_when`) and full page content.

## `_meta/` — indexes, extracts, and tooling

| File | What it is |
|---|---|
| `llms.txt` | The site's official docs index (all pages with descriptions), as published by OpenClaw. |
| `llms-full.txt` | The site's full documentation bundle — **all pages in one 27 MB file**. Fastest single file to grep when you need something across the whole corpus. |
| `sitemap.xml` | Raw sitemap (15,503 URLs — includes 28 translated locales not mirrored locally; English pages were extracted from it). |
| `en_urls.txt` | The 1,397 English page URLs from the sitemap that were scraped. |
| `links.md` | **All extracted links** — summary, full internal doc-path table (1,389 paths), missing paths, assets, and every external URL (GitHub bulk list split out to `github-links.txt`). |
| `links.json` | Machine-readable version of the same, incl. a **per-page link map** (`per_file`) and per-category link counts. |
| `github-links.txt` | All 41,704 unique github.com links one per line (mostly PR/commit references from the release notes pages). |
| `refresh.sh` | Re-scrape script: rebuilds the URL list from the sitemap and re-fetches every page + meta file. |
| `fetch_page.sh` | Fetches a single page (used by `refresh.sh`; safe to call standalone). |
| `extract_links.py` | Regenerates `links.md`, `links.json`, `github-links.txt` from the scraped pages. |
| `fetch_failures.txt` | Empty — kept as the log target for future refreshes. |

## Notes

- **Translations not mirrored.** The live site also publishes ~28 localized versions (Arabic, Chinese, German, Japanese, etc.). Only the English docs were scraped; the full translated URL set is still present in `sitemap.xml` if ever needed.
- **13 referenced paths have no local file**, all of them non-pages or stale docs links: 11 `/<section>/index` aliases that 404 on the live site too (the real hub is `/<section>`, e.g. `/channels`), plus `/api/search` (an API endpoint) and `/llms.txt` (a meta file, already saved in `_meta/`).
- Content is by the [OpenClaw Foundation](https://openclaw.org) (MIT-licensed project docs), mirrored locally for reference and agent context.

## Usage

```bash
# Refresh the mirror to the latest docs (adds/updates pages, downloads meta files)
./_meta/refresh.sh

# After a refresh, regenerate the link indexes
python3 _meta/extract_links.py
```
