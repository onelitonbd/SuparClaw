---
name: web-digest
description: Research a topic on the web and return a short sourced digest instead of raw links
read_when:
  - the user asks for research, a summary of a topic, or the latest news about something
  - the user shares a URL and wants it digested
  - the user asks to compare options that need current information
---

# Web digest

Turn the web into three to six useful sentences with sources.

1. **Search first** with `web_search` (2–3 queries with different phrasing). Do not search one
   query and stop — one bad query returns one bad source.
2. **Fetch the two or three best sources** with `web_fetch`. Prefer primary sources: official docs,
   project pages, filings, release notes. Skip SEO farms and undated listicles.
3. **Cross-check before believing.** If two credible sources disagree, say so instead of picking one.
4. **Write the digest** in this order:
   - the direct answer in one or two sentences,
   - 3–6 bullets of supporting detail with concrete numbers or names,
   - `Sources:` list of the URLs you actually fetched.
5. Mark the date for anything volatile ("as of 2026-10-19"). Never present a guess as a fact.
6. If fetching fails, say which step failed. Never fabricate citations.