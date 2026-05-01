# Web Access Service Design

Date: 2026-05-01

## Goal

Make Vulture's agent-controlled networking a first-class gateway service instead
of inline ad hoc fetch code inside local tool execution. The first phase should
support model-independent web search and URL fetch/extraction while preserving
the current `web_search` and `web_fetch` tool contract.

## Context

Vulture already exposes `web_search` and `web_fetch` as local gateway tools.
They are not model-hosted tools, which is the correct direction for a
multi-model agent product. The current implementation is too thin: search is
hard-coded to DuckDuckGo HTML parsing, fetch has no shared policy layer, there
is no provider abstraction, and tests only validate the inline happy path.

Browserbase and browser-use belong to a later browser automation layer. They
should not be used as the primary implementation for normal search/fetch.

## Non-Goals

- Do not add Browserbase, browser-use, Playwright, or browser UI automation in
  this phase.
- Do not switch to OpenAI hosted web search as the primary path.
- Do not add paid search providers or credential management yet.
- Do not change the visible `web_search` and `web_fetch` tool names.
- Do not build a settings page for search providers in this phase.

## Architecture

Add a focused `WebAccessService` in the gateway runtime. It owns provider
selection, fetch timeouts, private-host classification, search result parsing,
and content truncation. `gatewayLocalTools` should call this service rather than
embedding DuckDuckGo and raw fetch behavior.

Core interfaces:

```ts
interface SearchProvider {
  readonly id: string;
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
}

interface WebAccessService {
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
  fetch(request: WebFetchRequest): Promise<WebFetchResponse>;
  classifyUrl(value: unknown): WebUrlClassification;
}
```

The first provider is `DuckDuckGoHtmlSearchProvider`, backed by the injectable
gateway `fetch` function. The provider should remain replaceable so SearXNG,
Brave, Tavily, or other providers can be added later without touching local
tool execution.

## Permission Boundary

`web_search` is public internet read and may run without approval in ordinary
sandbox modes. `web_fetch` may run without approval for public `http(s)` URLs.
Private hosts, localhost, loopback, and non-HTTP protocols must require
approval or fail exactly as they do today.

This matches the product direction: workspace/file/process permissions are
separate from public web read permissions, while private network access remains
sensitive.

## Tool Outputs

Keep output compatibility:

`web_search`

```json
{
  "query": "string",
  "provider": "duckduckgo-html",
  "results": [{ "title": "string", "url": "string" }]
}
```

`web_fetch`

```json
{
  "url": "https://example.com/",
  "status": 200,
  "contentType": "text/html",
  "content": "string",
  "truncated": false
}
```

Additional metadata is allowed, but existing consumers should not need to
change.

## Error Handling

- Missing search query returns `tool.execution_failed`.
- Invalid fetch URL returns `tool.execution_failed`.
- Non-HTTP URL returns `tool.permission_denied`.
- Private host without approval returns `tool.permission_denied`.
- Search/fetch timeout returns a clear execution failure.
- Provider parse failures return an empty result list rather than crashing.

## Testing

Use TDD around the new service and the gateway integration:

- Service tests for public/private URL classification.
- Service tests for DuckDuckGo result parsing and result limits.
- Service tests for fetch timeout and max-byte truncation.
- Gateway local tool tests showing public web search/fetch no longer require
  approval in workspace-scoped permission modes.
- Gateway local tool tests showing private/local fetch still requires approval.

## Future Extensions

After this phase, add SearXNG/provider settings, structured `web_extract`, and
browser automation providers. Those should build on this service rather than
recreating networking policy in separate tools.
