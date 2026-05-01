# Web Extract Tool Design

Date: 2026-05-01

## Goal

Add a structured web extraction tool so agents can read public web pages through
Vulture's own Web Access Service instead of relying on model-hosted browsing or
raw HTML fetches.

## Scope

This phase adds `web_extract` as a core, idempotent web-read tool. It returns a
page title, meta description, readable text, and resolved links. It does not add
browser automation, JavaScript rendering, credentialed browsing, screenshots, or
Browserbase/browser-use integration.

## Tool Contract

Input:

```json
{
  "url": "https://example.com/page",
  "maxBytes": 256000,
  "maxLinks": 30
}
```

Output:

```json
{
  "url": "https://example.com/page",
  "status": 200,
  "contentType": "text/html",
  "title": "Example",
  "description": "Example page",
  "text": "Readable page text",
  "links": [{ "text": "Docs", "url": "https://example.com/docs" }],
  "truncated": false
}
```

## Permission Model

`web_extract` uses the same boundary as `web_fetch`: public `http(s)` URLs are
safe and idempotent, while private hosts, localhost, loopback, and non-HTTP
schemes require approval or fail closed.

## Implementation

`WebAccessService.extract()` classifies the URL, fetches with the shared timeout
path, and extracts structured text from HTML. HTML extraction removes hidden
script/style/noscript content and excludes `<head>` from body text. Links are
resolved against the requested URL and limited to a bounded count.

Plain-text responses return `title: null`, `description: null`, no links, and
truncated text.

## Testing

Coverage includes:

- service extraction for HTML title, description, body text, and absolute links.
- service extraction for plain text and truncation.
- local tool execution through `makeGatewayLocalTools`.
- SDK adapter approval behavior and idempotency.
- protocol/tool preset/catalog synchronization.
