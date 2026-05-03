---
name: web-research
description: Use when needing information from the web — choosing between web_search, web_fetch, and web_extract, evaluating source quality, and avoiding context bloat.
---

# Web Research

## Tool selection

- **web_search** — when you don't know the URL. Returns titles + snippets + URLs for a query. Cheap. First step for any unknown topic.
- **web_fetch** — when you have a specific URL and want raw text content. Best for reading a known page top-to-bottom.
- **web_extract** — when you want structured page output (title, description, main text, links). Best for triaging a page before deciding to fetch the whole thing.

Default flow: **search → extract → fetch**.

## Quality signals

Prefer:
- Official docs (e.g. `nodejs.org`, `developer.mozilla.org`, language-server protocol spec sites).
- Source repos (`github.com/<org>/<repo>` README, `docs/`, releases).
- Authoritative blogs (well-known engineering teams' eng blogs).

Treat with care:
- StackOverflow answers older than 3 years — APIs change.
- AI-generated SEO sites with no author or date.
- Tutorials that don't link back to source docs.

## Avoiding context bloat

- Pull only the smallest passage that answers the question. A `web_fetch` of an entire spec page can blow context.
- Prefer extracting a structured summary (`web_extract`) and citing the URL, over inlining the full text.
- After research, write down the answer in your own words and discard the raw fetch.

## When NOT to use the web
- The codebase already has the answer — read it instead.
- The question is about user intent — ask the user.
- The question can be answered by reading a man page or running `--help` locally.
