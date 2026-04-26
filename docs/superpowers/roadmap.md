# Vulture Architecture Roadmap

This file tracks the post-L0 sub-projects that are deliberately deferred from the L0 skeleton. Each item gets its own brainstorm → spec → plan → implementation cycle.

L0 is the prerequisite for all of these. Once L0 lands ([2026-04-26-gateway-skeleton-design.md](specs/2026-04-26-gateway-skeleton-design.md)), the sub-projects below can proceed in dependency order. Items in the same level can in principle run in parallel.

## L1 — Persistence depth

Goal: stop losing in-flight work, start tracking real costs.

- **Run persistence and recovery** — survive Gateway restarts mid-run instead of marking everything `failed`.
- **Token usage / cost tracking** — record per-run token counts, propagate to UI.
- **Multi-profile** — multiple local profiles, switcher in UI, isolated data and Keychain entries.
- **Multimodal messages** — image and file attachments in messages, persisted as blobs.
- **OpenAPI auto-codegen** — replace L0's CI-diff approach with single-source generation.

## L2 — Knowledge layer

Goal: agents that remember and that can be extended without code changes.

- **Skill system** — loadable higher-level capability bundles, separate from atomic Tools, attachable to templates.
- **Memory + vector store** — sqlite-vec backed episodic and semantic memory with decay, queried by agent runtime.

## L3 — External integration

Goal: be a peer in the broader tool ecosystem.

- **L3a MCP client** — call external MCP servers from Vulture; surface their tools alongside built-ins.
- **L3a MCP server** — expose Vulture as an MCP server for other agents (Cursor, Claude Code, etc.) to use.
- **L3b PTY terminal** — node-pty backed real terminal as a tool, for interactive shells.
- **L3c CDP browser upgrade** — replace the current content-script Chrome extension with a Chrome DevTools Protocol relay.

## L4 — Multi-agent

Goal: agents that delegate to other agents.

- **Subagent / multi-agent orchestration** — handoffs, isolated subagent session stores, parent-child run tracking.

## Out of plan

Things that are not planned and would require a product-direction change before being added:

- User accounts, cloud sync, billing.
- Remote external clients (Gateway is 127.0.0.1 only by design).
- Real RBAC / multi-user permissions.
- Windows / Linux ports — not actively pursued, but no macOS-only APIs are written into shared code in case we change our mind later.
- Gateway running in the background after Tauri exits.
- A standalone CLI bringing up its own Gateway.
