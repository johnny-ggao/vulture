# Vulture

[English](README.md) ・ [中文](README.zh-CN.md)

**Vulture** is a local-first, hybrid desktop AI agent platform. It runs entirely on your machine: a Tauri Rust core for trusted system access, a Bun sidecar running the OpenAI Agents SDK for orchestration, a React + TypeScript UI, and an optional Chrome extension for browser control. No cloud accounts, no telemetry by default — local profiles replace accounts, and secrets live in the macOS Keychain.

The first platform target is **macOS**. Windows and Linux are kept architecturally possible but not actively pursued.

## Highlights

- **Local-first** — every conversation, run, and credential stays on your machine.
- **Modular core** — clear trust zones between UI, Rust core, sidecar, and browser extension.
- **Policy-gated tools** — the Rust core decides whether each tool call is allowed, requires approval, or is denied. LLM-side code never gets ambient authority.
- **Browser as a tool** — full Chrome extension + relay subsystem, fully audited.
- **Profile-scoped data** — multiple isolated profiles, each with its own data and Keychain entries.
- **Typed protocol** — JSON Schema sources of truth shared between TypeScript and Rust.

## Architecture

```text
┌──────────────────────────┐
│ React UI (apps/desktop-ui)│  no secrets, no fs, no direct sidecar
└──────────────┬────────────┘
               │ Tauri IPC
┌──────────────▼────────────┐
│ Tauri Rust Core           │  keychain · fs · pty · profiles · audit
│ (apps/desktop-shell)      │  policy · permissions · supervision
└──────┬────────────┬───────┘
       │ tool RPC   │ supervises
┌──────▼─────┐  ┌───▼───────────────┐
│ Tool       │  │ Bun Agent Sidecar │  OpenAI Agents SDK
│ Gateway    │  │ (apps/gateway)    │  handoffs · MCP · streaming
│ (Rust)     │  └───────────────────┘
└──────┬─────┘
       │ relay
┌──────▼────────────────────┐
│ Chrome Extension          │  high-risk, paired per profile, audited
│ (extensions/browser)      │
└───────────────────────────┘
```

## Repository layout

```text
apps/desktop-ui      React + TypeScript UI
apps/desktop-shell   Tauri Rust app, system integration
apps/gateway         Bun sidecar, OpenAI Agents SDK runtime
extensions/browser   Chrome MV3 extension for browser control
crates/core          Shared Rust domain types
crates/tool-gateway  Rust tool execution, policy, audit
packages/protocol    Shared JSON schemas + generated TS/Rust bindings
packages/agent-runtime, packages/llm, packages/common
docs/superpowers     Specs, plans, reports, roadmap
```

## Requirements

- macOS (Apple Silicon recommended)
- Rust toolchain (pinned via `rust-toolchain.toml`)
- [Bun](https://bun.sh) ≥ 1.1
- Node 22+ (only needed for some tooling)
- Xcode Command Line Tools

## Getting started

```bash
# install JS workspace deps
bun install

# launch the desktop UI in dev mode
bun run dev

# typecheck the whole workspace
bun run typecheck

# run the protocol unit tests
bun run test
```

To build a desktop bundle, drive the Tauri app from `apps/desktop-shell` (see its `tauri.conf.json`).

## Verification

The repo ships layered verification scripts. Use the smallest one that covers your change:

| Scope | Command |
|------|---------|
| Browser subsystem | `bun run verify:browser` |
| Command center (UI + core) | `bun run verify:command-center` |
| Full sweep (TS + Rust + clippy) | `bun run verify` |

Each script runs the relevant TypeScript typecheck, Bun tests, Cargo tests, and `cargo clippy -D warnings`.

## Roadmap

Vulture is being built in milestones. The current state is **L0** (gateway skeleton). Tracked sub-projects:

- **L1 — Persistence depth**: run recovery, token/cost tracking, multi-profile, multimodal messages, OpenAPI codegen.
- **L2 — Knowledge layer**: skill system, sqlite-vec memory store.
- **L3 — External integration**: MCP client/server, PTY terminal, CDP browser upgrade.
- **L4 — Multi-agent**: subagent orchestration and parent–child run tracking.

Full roadmap: [docs/superpowers/roadmap.md](docs/superpowers/roadmap.md).

## Out of scope

These are intentionally **not** planned:

- User accounts, cloud sync, billing.
- Remote external clients — the gateway binds to `127.0.0.1` only.
- Real RBAC / multi-user permissions.
- Background gateway after the desktop app exits.
- A standalone CLI bringing up its own gateway.

## License

UNLICENSED — see [`Cargo.toml`](Cargo.toml). All rights reserved by the author until a license is published.
