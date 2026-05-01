# Browser Tool Expansion Design

Date: 2026-05-01

## Goal

Expand the existing Chrome extension relay from snapshot/click-only into a
small usable browser interaction loop for agents.

## Scope

Add three core tools:

- `browser.input`: set or type text into an element selected by CSS selector.
- `browser.scroll`: scroll the page or a selected element.
- `browser.extract`: extract title, URL, visible text, and links from the active tab.

This phase keeps the current polling relay and does not introduce Browserbase,
Playwright, CDP forwarding, screenshots, navigation, or multi-tab session
management.

## Architecture

The gateway continues to expose browser tools as approval-required core tools.
Execution still routes through the existing Rust shell callback server. The Rust
relay treats all `browser.*` tools as extension actions and waits for the
extension result. The extension dispatches tool requests to the active tab and
the content script performs DOM operations.

## Tool Contracts

`browser.input`

```json
{ "selector": "input[name=q]", "text": "OpenAI Agents SDK", "submit": false }
```

`browser.scroll`

```json
{ "selector": null, "deltaY": 800 }
```

`browser.extract`

```json
{ "maxTextChars": 20000, "maxLinks": 50 }
```

## Permission Model

All browser tools require approval. `browser.snapshot` and `browser.extract` are
idempotent; `browser.click`, `browser.input`, and `browser.scroll` are not
treated as idempotent because they can change page state.

## Testing

Coverage should include:

- core registry exposes the new tools and approval metadata.
- SDK adapter asks for approval for the new tools.
- Rust callback relay forwards all `browser.*` tools to the extension.
- extension request dispatch supports input, scroll, and extract.
- desktop tool capability grouping includes the new tools.
