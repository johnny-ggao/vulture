# Coding Foundation Design

Date: 2026-05-03

## Goal

Build the missing capability floor that makes the upcoming preset agents — `Vulture` (general) and `Vulture Coding` — actually useful. Today the agent toolset and skill catalog do not contain the primitives a real coding partner needs. This spec adds them.

Specifically:

1. Six new first-class tools: `grep`, `glob`, `lsp.diagnostics`, `lsp.definition`, `lsp.references`, `lsp.hover`.
2. A managed LSP client (`apps/gateway/src/runtime/lspClientManager.ts`) supporting **TypeScript** and **Rust** only.
3. A **builtin** skill source: a fourth, lowest-precedence `loadSkillEntries` source that ships six bundled skill markdowns alongside the gateway.

This spec is a hard prerequisite for [`2026-05-03-preset-agents-design.md`](./2026-05-03-preset-agents-design.md). The preset spec will be updated after this lands to reference the new capabilities.

## Context

### Tool surface today

`packages/protocol/src/v1/agent.ts` defines `AGENT_TOOL_NAMES`: read / write / edit / apply_patch / shell.exec / process / web_* / browser.* / memory_* / sessions_* / update_plan. There is no first-class search (text or filename), no LSP, no language-aware navigation. Coding workflows currently lean on `shell.exec` plus ad-hoc `grep` invocations, which:

- Burn context on noisy stderr.
- Are hard to model in `crates/tool-gateway` policy/audit.
- Force the agent to parse free-form output rather than structured results.

### Skill surface today

`apps/gateway/src/runtime/skills.ts` already supports a three-source merged skill catalog: `profile/skills`, `workspace/skills`, `agent-core/skills`. The gateway ships **zero** builtin skill files. A freshly installed user has an empty skills directory; `Vulture Coding` would be hollow without something to read.

### Repository languages

Vulture's repo is TypeScript (apps + packages) and Rust (Tauri shell + crates). LSP scope is intentionally restricted to these two languages; broader coverage is out of scope.

## Confirmed Decisions

1. **Six new tools, all read-only, auto-approve.** No write/exec semantics. Approval is handled in TS via `coreToolApprovalDecision` (returns `{ needsApproval: false }`) — these tools are TS-local (added to `LOCAL_TOOL_NAMES` in `gatewayLocalTools.ts`) and never traverse the Rust `crates/tool-gateway`. No Rust changes required.
2. **Tool preset assignments**:
   - `minimal` and `standard` gain `grep` and `glob` (basic discovery — every preset benefits).
   - `developer` gains all four `lsp.*` on top of grep/glob.
   - `tl` mirrors `standard` (no LSP).
   - `full` continues to mean `AGENT_TOOL_NAMES`, which now includes the six new entries automatically.
3. **`grep` uses ripgrep with a JS fallback.** Detect `rg` on PATH; if absent, fall back to a Node implementation (slower but correct). Never hard-fail the tool because ripgrep is missing.
4. **`glob` uses an existing npm matcher** (`fast-glob` or `tinyglobby`, whichever is already a transitive dep). No new top-level dependency unless required.
5. **LSP languages**: TypeScript (`.ts`/`.tsx`/`.mts`/`.cts`) and Rust (`.rs`) only. `.js`/`.jsx` are intentionally excluded — without `tsconfig.json` the inferred-project diagnostics are pure noise.
6. **LSP capability set**: `diagnostics`, `definition`, `references`, `hover`. These four constitute the "read + understand" loop. `rename` / `code_actions` / `document_symbols` / `workspace_symbols` / `completion` are explicitly tech debt (see §Tech Debt below).
7. **LSP server lifecycle**:
   - Lazy spawn on first `lsp.*` call for a given `(workspaceRoot, language)` pair.
   - 5-minute idle TTL; graceful shutdown after TTL.
   - `dispose()` all servers on gateway shutdown.
   - If the language server binary is not found, the tool returns `{ error: { code: "lsp.server_not_found", install_hint: "..." } }` — the rest of the gateway is unaffected.
   - If the project config is missing (`tsconfig.json` for TS, `Cargo.toml` for Rust), return `{ error: { code: "lsp.no_project_config", ... } }` rather than emitting noisy inferred diagnostics.
8. **Server discovery order**:
   - TypeScript: workspace `node_modules/.bin/typescript-language-server` → `which typescript-language-server`.
   - Rust: `which rust-analyzer` → `~/.cargo/bin/rust-analyzer`.
9. **Builtin skills are a fourth `loadSkillEntries` source at the lowest precedence.** Files live in `apps/gateway/builtin-skills/`. The merge order becomes `builtin → profile → workspace → agent-core` (later writes overwrite earlier in the existing `Map` pattern). Users override a builtin skill simply by placing the same `name` file in their profile/workspace/agent-core directories.
10. **Initial builtin skill set**: six skills shipped together. Engineering: `tdd-workflow`, `systematic-debugging`, `verification-before-done`, `code-review-checklist`. Cross-cutting: `web-research`, `task-decomposition`. Each ≤ 200 lines, frontmatter `name` + `description`, action-oriented.
11. **No per-agent allowlist gating for builtin skills.** They are globally visible; the skill's own `description` controls when the model triggers it.

## Design

### §1 — Protocol and tool registration

`packages/protocol/src/v1/agent.ts`:

```ts
export const AGENT_TOOL_NAMES = [
  // ...existing entries...
  "grep",
  "glob",
  "lsp.diagnostics",
  "lsp.definition",
  "lsp.references",
  "lsp.hover",
] as const;
```

Preset deltas:

```ts
minimal: ["read", "grep", "glob", "web_search", "web_fetch", "web_extract"],
standard: [/* existing */, "grep", "glob"],
developer: [/* existing */, "grep", "glob", "lsp.diagnostics", "lsp.definition", "lsp.references", "lsp.hover"],
tl: [/* existing */, "grep", "glob"],
full: AGENT_TOOL_NAMES, // unchanged shape
```

No Rust binding changes — the protocol's `AGENT_TOOL_NAMES` enum is TS-only and is not mirrored by `crates/tool-gateway` (which deals with system-level dispatch only). The new tools are added to `LOCAL_TOOL_NAMES` in `apps/gateway/src/runtime/gatewayLocalTools.ts` so they are handled inside the gateway and never fall through to the Rust shell-tools layer. `apps/gateway/src/tools/coreTools.ts` registers six new dispatch handlers backed by:

- `grep` → `runtime/grep.ts` (ripgrep child process if available, JS fallback otherwise).
- `glob` → `runtime/glob.ts` (existing matcher).
- `lsp.*` → `runtime/lspClientManager.ts` (see §2).

#### Tool schemas

| Tool | Input | Output |
|---|---|---|
| `grep` | `pattern: string`, `path?: string`, `glob?: string`, `regex?: bool`, `caseSensitive?: bool`, `maxMatches?: number = 200` | `{ matches: Array<{ file, line, column, text }>, truncated: bool }` |
| `glob` | `pattern: string`, `path?: string`, `maxResults?: number = 500` | `{ paths: string[], truncated: bool }` |
| `lsp.diagnostics` | `filePath: string` | `{ diagnostics: Array<{ range, severity, message, source }> }` or `{ error: { code, ... } }` |
| `lsp.definition` | `filePath, line, character` | `{ locations: Array<{ filePath, range }> }` |
| `lsp.references` | `filePath, line, character`, `includeDeclaration?: bool = true` | `{ locations: Array<{ filePath, range }> }` |
| `lsp.hover` | `filePath, line, character` | `{ contents: string \| null, range: Range \| null }` |

All file paths are resolved against the conversation's `workspace.path`; out-of-workspace paths return `{ error: { code: "path_outside_workspace" } }` (reuse `runtime/skills.ts`'s `isPathInside` helper).

### §2 — LSP client manager

New file `apps/gateway/src/runtime/lspClientManager.ts`.

```ts
export type LspLanguage = "typescript" | "rust";

export function detectLanguage(filePath: string): LspLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
  if (ext === ".rs") return "rust";
  return null;
}

export interface LspClientManager {
  diagnostics(workspaceRoot: string, filePath: string): Promise<LspResult<Diagnostic[]>>;
  definition(workspaceRoot: string, filePath: string, line: number, character: number): Promise<LspResult<Location[]>>;
  references(workspaceRoot: string, filePath: string, line: number, character: number, includeDecl: boolean): Promise<LspResult<Location[]>>;
  hover(workspaceRoot: string, filePath: string, line: number, character: number): Promise<LspResult<HoverContent | null>>;
  dispose(): Promise<void>;
}
```

#### Implementation strategy

- Use `vscode-jsonrpc` + `vscode-languageserver-protocol` from npm (industry standard, low maintenance).
- Internal cache: `Map<string, LspServerHandle>` keyed by `${workspaceRoot}::${language}`.
- Each `LspServerHandle` tracks: child process, JSON-RPC connection, last-used timestamp, opened-document set, init promise.
- Idle sweep: a 60-second interval timer disposes any handle untouched for 5+ minutes.
- File open is lazy: before any request on a file, send `textDocument/didOpen`. Track opened files; on next file query in the same server reuse the open. Files that change on disk between queries get re-sent via `didOpen` (we do not implement `didChange`; the agent's edits go through `edit` / `apply_patch`, after which the LSP reads from disk).

Note: this lazy `didOpen` approach is sufficient for diagnostics/definition/references/hover but means each query incurs one extra round-trip on first touch.

#### Server binary discovery

Resolved at handle construction time:

```ts
async function resolveServer(language: LspLanguage, workspaceRoot: string): Promise<string | null> {
  if (language === "typescript") {
    const local = path.join(workspaceRoot, "node_modules", ".bin", "typescript-language-server");
    if (await exists(local)) return local;
    return await which("typescript-language-server");
  }
  if (language === "rust") {
    const fromWhich = await which("rust-analyzer");
    if (fromWhich) return fromWhich;
    const cargoBin = path.join(homedir(), ".cargo", "bin", "rust-analyzer");
    if (await exists(cargoBin)) return cargoBin;
    return null;
  }
  return null;
}
```

Resolution failure → `{ error: { code: "lsp.server_not_found", install_hint: "..." } }`. The gateway logs once per language per process to avoid log spam.

#### Project config gate

Before spawning, verify the relevant config exists at the workspace root:

- TypeScript: `tsconfig.json` or `jsconfig.json` (the latter accepted because TS server can use it).
- Rust: `Cargo.toml`.

Missing → `{ error: { code: "lsp.no_project_config" } }` without spawning a server.

#### Initialization

Standard LSP `initialize` with `rootUri` set to the workspace, `capabilities` containing only what the four tools need. After `initialize` resolves, send `initialized`. Pending requests during init are queued.

For rust-analyzer, indexing can take 30+ seconds on a cold project. We do **not** wait for indexing in the manager. The first request times out at 30s and surfaces `{ error: { code: "lsp.indexing", retry_in_seconds: 30 } }`. Subsequent requests succeed once indexing completes.

### §3 — Builtin skills

#### Source layout

```
apps/gateway/
  builtin-skills/
    tdd-workflow.md
    systematic-debugging.md
    verification-before-done.md
    code-review-checklist.md
    web-research.md
    task-decomposition.md
```

Each file follows the existing skill format consumed by `runtime/skills.ts`:

```markdown
---
name: <slug-matching-filename-without-md>
description: Use when <triggering condition>. Provides <one-line capability>.
---

# <Title>

## When to use
- ...

## Steps
1. ...

## Common pitfalls
- ...
```

The exact markdown bodies are produced as part of the implementation PR, not pinned word-for-word in this spec. Each file ≤ 200 lines, action-oriented (a checklist a model can immediately follow), not prose.

#### Loader changes

`apps/gateway/src/runtime/skills.ts`:

```ts
export interface LoadSkillEntriesOptions {
  workspaceDir: string;
  profileDir?: string;
  agentCoreDir?: string;
  builtinDir?: string;          // NEW
  maxSkillFileBytes?: number;
}

// SkillEntry source union extended
source?: "builtin" | "profile" | "workspace" | "agent-core";
```

Inside `loadSkillEntries`:

```ts
const builtinSkills = opts.builtinDir
  ? loadSkillsFromRoot(opts.builtinDir, max, "builtin")
  : [];
// Existing precedence: profile > workspace > agent-core.
// New full precedence: builtin (lowest) > profile > workspace > agent-core (highest).
for (const skill of builtinSkills) merged.set(skill.name, skill);
for (const skill of profileSkills) merged.set(skill.name, skill);
for (const skill of workspaceSkills) merged.set(skill.name, skill);
for (const skill of agentCoreSkills) merged.set(skill.name, skill);
```

#### `builtinDir` resolution

The gateway resolves at module load:

```ts
const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../builtin-skills/", import.meta.url));
```

(Path relative to `apps/gateway/src/runtime/skills.ts` is `../../builtin-skills/`.) The runtime call site that constructs `LoadSkillEntriesOptions` (currently `server.ts`'s `skillsPromptForAgent`) passes this directory.

For bundled / single-file gateway distributions (if and when they exist), the build tool must copy `builtin-skills/` next to the bundle entry. This is called out in the implementation plan but does not change the runtime contract.

#### User override path

Already supported by the existing precedence. Documented as: "drop a `<name>.md` into `<profile>/skills/`, `<workspace>/skills/`, or `<agent-core>/skills/` to replace a builtin." No new code.

## Out of Scope

- LSP capabilities beyond the four read operations (see Tech Debt).
- LSP for JavaScript, Python, Go, Markdown, etc.
- A first-class `git.*` tool family — `shell.exec` of `git` continues to be the path.
- A first-class `test.run` tool — same.
- Agent-specific allowlists for builtin skills.
- A skill-update prompt UI ("there are new builtin skills, want to refresh?"). Updates are silent (replace the file in `apps/gateway/builtin-skills/`, ship the gateway).
- Skill content authoring — the six markdown bodies are written in the implementation PR.

## Tech Debt (acknowledged, not addressed)

The following are known capability gaps. They will be filed as follow-up specs after the foundation lands:

- **LSP-FullSet**: `rename`, `code_actions`, `document_symbols`, `workspace_symbols`, `completion`. Required to make Vulture Coding genuinely competitive with editor-integrated assistants.
- **LSP-Languages**: Python (pyright/jedi), Go (gopls), C/C++ (clangd). Triggered by user demand, not by Vulture's current repo.
- **Test runner tool**: `test.run(framework?, scope?)` with framework auto-detection (vitest/jest/cargo test/pytest).
- **Git tool family**: `git.diff`, `git.log`, `git.status`, `git.show`. Structured output, no shell parsing.
- **Notebook tools**: out of scope until a real Jupyter use case appears in Vulture.

## Files Touched

- `packages/protocol/src/v1/agent.ts` — append six tool names, update preset arrays.
- `packages/protocol/src/v1/agent.test.ts` — preset coverage, enum exhaustiveness.
- `apps/gateway/src/runtime/gatewayLocalTools.ts` — extend `LOCAL_TOOL_NAMES`, add dispatch arms for the six new tools.
- `apps/gateway/src/runtime/gatewayLocalTools.test.ts` — coverage for grep/glob/lsp dispatch.
- `apps/gateway/src/tools/coreTools.ts` — register six new handlers + approval decisions.
- `apps/gateway/src/runtime/grep.ts` — new file (ripgrep + JS fallback).
- `apps/gateway/src/runtime/glob.ts` — new file (matcher wrapper).
- `apps/gateway/src/runtime/lspClientManager.ts` — new file.
- `apps/gateway/src/runtime/lspClientManager.test.ts` — unit + integration tests.
- `apps/gateway/src/runtime/skills.ts` — add `builtinDir` source.
- `apps/gateway/src/runtime/skills.test.ts` — four-source merge order, override.
- `apps/gateway/builtin-skills/*.md` — six new files.
- `apps/gateway/src/server.ts` — wire `BUILTIN_SKILLS_DIR` into `skillsPromptForAgent`.
- `docs/superpowers/specs/2026-05-03-preset-agents-design.md` — update §6 / risks to reference this foundation as a prerequisite (handled in a later commit, not in this spec's implementation).

## Risks & Mitigations

- **LSP server binaries are user-installed dependencies**, not bundled. New users may not have `rust-analyzer` or `typescript-language-server` on PATH. Mitigation: structured `lsp.server_not_found` error with `install_hint`; UI surfaces a "missing dependency" banner only after the first failed call. (Banner UI is preset spec scope, not foundation.)
- **rust-analyzer cold-start is 30+ seconds.** Mitigation: 30s timeout returning `lsp.indexing` error; subsequent calls succeed. Document this in the `lsp.*` tool descriptions so the agent doesn't loop on the timeout.
- **Builtin skill versioning is implicit** — replacing a file in `builtin-skills/` silently changes content for all users on next gateway start. Acceptable given dev phase. If we hit the situation where a "load-bearing" skill version needs to be announced, we can later add a one-time toast on detected version change.
- **`grep` JS fallback may be slow on large repos**. Mitigation: enforce `maxMatches` cap (default 200), document that ripgrep install is recommended for performance; the JS fallback is correctness-only.
- **`builtin-skills/` path resolution under bundled distribution** is non-trivial. Mitigation: keep the resolver behind `BUILTIN_SKILLS_DIR` constant in one place; bundle build step (when introduced) only needs to update that constant or copy the directory next to the bundle.
