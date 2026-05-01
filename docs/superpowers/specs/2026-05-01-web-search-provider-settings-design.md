# Web Search Provider Settings Design

Date: 2026-05-01

## Goal

Make Vulture's model-independent `web_search` tool configurable. The first
configurable provider is SearXNG, while DuckDuckGo HTML remains the no-key
default fallback.

## Scope

- Add a local profile-level web search settings store.
- Add gateway routes to read, update, and test search provider settings.
- Add a `SearxngSearchProvider` to `WebAccessService`.
- Wire gateway local tools so provider changes apply without restarting.
- Add a Settings page section for selecting DuckDuckGo HTML or SearXNG.

## Non-Goals

- No paid search providers or API-key management.
- No Browserbase, browser-use, Playwright, or browser automation.
- No `web_extract` tool in this phase.
- No per-agent search provider override.

## Data Model

```ts
type WebSearchProviderId = "duckduckgo-html" | "searxng";

interface WebSearchSettings {
  provider: WebSearchProviderId;
  searxngBaseUrl: string | null;
  updatedAt: string;
}
```

Store the settings at:

```text
<profileDir>/settings/web-search.json
```

The default is:

```json
{
  "provider": "duckduckgo-html",
  "searxngBaseUrl": null
}
```

## API

- `GET /v1/web-search/settings`
- `PATCH /v1/web-search/settings`
- `POST /v1/web-search/test`

The settings response includes provider metadata for the UI:

```json
{
  "settings": { "provider": "duckduckgo-html", "searxngBaseUrl": null },
  "providers": [
    { "id": "duckduckgo-html", "label": "DuckDuckGo HTML", "requiresBaseUrl": false },
    { "id": "searxng", "label": "SearXNG", "requiresBaseUrl": true }
  ]
}
```

`POST /v1/web-search/test` runs a small query against either the current
settings or the submitted patch and returns provider, result count, and a
sample result. It does not mutate settings.

## Runtime

`makeGatewayLocalTools` receives a configured `WebAccessService` from server
local tools. The configured search provider reads current settings per search
call, so changing providers in Settings affects future runs without a gateway
restart.

## UI

Add a "联网" section under Settings. It shows:

- provider selector
- SearXNG base URL input when SearXNG is selected
- "测试搜索" action
- save status / error

Keep the UI operational and compact; do not add explanatory marketing copy.
