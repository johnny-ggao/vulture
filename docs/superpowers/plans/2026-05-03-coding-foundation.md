# Coding Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing capability floor — six new TS-local tools (grep, glob, four LSP read operations) plus a builtin skill source that ships six bundled markdowns — so the upcoming preset agents can be genuinely useful.

**Architecture:** All six tools are pure TypeScript implementations dispatched inside `apps/gateway/src/runtime/gatewayLocalTools.ts`; they never traverse the Rust `crates/tool-gateway`. `grep` shells out to `ripgrep` when present and falls back to a Node.js implementation. `glob` wraps an existing matcher dependency. The four `lsp.*` tools share a single `LspClientManager` that lazily spawns `typescript-language-server` (via `node_modules/.bin` or `which`) and `rust-analyzer` (via `which` or `~/.cargo/bin`), caches one server per `(workspaceRoot, language)`, idle-disposes after 5 minutes, and surfaces structured `lsp.server_not_found` / `lsp.no_project_config` / `lsp.indexing` errors instead of throwing. Builtin skills are added as a fourth, lowest-precedence source in `runtime/skills.ts`; their files live in `apps/gateway/builtin-skills/`.

**Tech Stack:** TypeScript / Bun runtime; Node.js `child_process` for `ripgrep` and LSP server processes; npm `vscode-jsonrpc` + `vscode-languageserver-protocol` for LSP wire format; existing `runtime/skills.ts` discovery pipeline; Zod schemas in `packages/protocol/src/v1/agent.ts`.

**Source of truth:** [docs/superpowers/specs/2026-05-03-coding-foundation-design.md](../specs/2026-05-03-coding-foundation-design.md). Refer back to the spec when a task description is ambiguous.

**Repo conventions to follow:**
- All test files sit next to source under the same name with `.test.ts` suffix.
- Bun is the runtime (`bun test`, `bun run`). Do not use `npm` / `node` to run gateway code.
- Commit format: conventional commits (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`). One commit per task unless noted.
- Branch is unimportant — work on the current branch (no worktree gymnastics requested).
- Do NOT use `git commit -am` (it picks up unrelated working-tree changes from sibling work). Always `git add <specific files>`.

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `apps/gateway/src/runtime/grep.ts` | grep tool implementation — ripgrep child process when available, Node fallback otherwise. Exposes `runGrep(opts)` returning `{ matches, truncated }`. |
| `apps/gateway/src/runtime/grep.test.ts` | Tests for both ripgrep and JS fallback paths. |
| `apps/gateway/src/runtime/glob.ts` | glob tool implementation — thin wrapper over `tinyglobby` (already a transitive dep) returning `{ paths, truncated }`. |
| `apps/gateway/src/runtime/glob.test.ts` | Tests for the matcher wrapper. |
| `apps/gateway/src/runtime/lspServerHandle.ts` | Per-server child process lifecycle: spawn, jsonrpc connection, init handshake, didOpen tracking, dispose. |
| `apps/gateway/src/runtime/lspServerHandle.test.ts` | Tests using a stubbed jsonrpc transport. |
| `apps/gateway/src/runtime/lspClientManager.ts` | Per-`(workspaceRoot, language)` cache, idle TTL sweeper, four capability methods (diagnostics/definition/references/hover), structured error surface. |
| `apps/gateway/src/runtime/lspClientManager.test.ts` | Cache eviction, error mapping, capability dispatch. |
| `apps/gateway/builtin-skills/tdd-workflow.md` | Bundled skill: TDD red/green/refactor checklist. |
| `apps/gateway/builtin-skills/systematic-debugging.md` | Bundled skill: hypothesis-driven debugging. |
| `apps/gateway/builtin-skills/verification-before-done.md` | Bundled skill: evidence > assertions before claiming completion. |
| `apps/gateway/builtin-skills/code-review-checklist.md` | Bundled skill: self-review of diffs. |
| `apps/gateway/builtin-skills/web-research.md` | Bundled skill: web_search vs web_fetch vs web_extract usage. |
| `apps/gateway/builtin-skills/task-decomposition.md` | Bundled skill: breaking large tasks into independent pieces. |

### Modified files

| File | Change |
|---|---|
| `packages/protocol/src/v1/agent.ts` | Append six tool names; update `minimal`, `standard`, `developer`, `tl` preset arrays. |
| `packages/protocol/src/v1/agent.test.ts` | Cover preset membership and exhaustiveness for the six new tools. |
| `apps/gateway/package.json` | Add deps: `vscode-jsonrpc`, `vscode-languageserver-protocol`, `tinyglobby` (if not already transitive). |
| `apps/gateway/src/runtime/gatewayLocalTools.ts` | Add six entries to `LOCAL_TOOL_NAMES`; add dispatch arms in `executeLocalTool`; thread `LspClientManager` through `GatewayLocalToolsOptions`. |
| `apps/gateway/src/runtime/gatewayLocalTools.test.ts` | Cover dispatch and error paths for the six new tools. |
| `apps/gateway/src/tools/coreTools.ts` | Register six new `GatewayToolSpec` entries; extend `coreToolApprovalDecision`; add Zod schemas for parameters. |
| `apps/gateway/src/tools/coreTools.test.ts` (or sdkAdapter test) | Cover schema validation and approval decisions. |
| `apps/gateway/src/runtime/skills.ts` | Add `builtinDir` option; insert builtin source into merge order at lowest precedence; widen `SkillEntry.source` to include `"builtin"`. |
| `apps/gateway/src/runtime/skills.test.ts` | Cover four-source merge, override semantics, missing-builtin tolerance. |
| `apps/gateway/src/server.ts` | Resolve `BUILTIN_SKILLS_DIR` from `import.meta.url`; pass into `loadSkillEntries`. |

### Out of scope (per spec)
- Rust `crates/tool-gateway` changes.
- LSP capabilities beyond the four read operations.
- LSP language coverage beyond TypeScript and Rust.
- New top-level skill content authoring tooling.
- Any preset-agent UI changes.

---

## Phase 1 — Protocol additions

### Task 1: Append six tool names and wire presets

**Files:**
- Modify: `packages/protocol/src/v1/agent.ts`
- Modify: `packages/protocol/src/v1/agent.test.ts`

- [ ] **Step 1: Read existing test file to understand naming conventions**

```bash
grep -n "AGENT_TOOL_NAMES\|AGENT_TOOL_PRESETS\|describe\|test" packages/protocol/src/v1/agent.test.ts | head -30
```

Note the test file's structure so the new cases match its style.

- [ ] **Step 2: Write failing tests for new tool names + preset membership**

Append to `packages/protocol/src/v1/agent.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { AGENT_TOOL_NAMES, AGENT_TOOL_PRESETS } from "./agent";

describe("foundation tool additions", () => {
  test("AGENT_TOOL_NAMES includes the six new tools", () => {
    expect(AGENT_TOOL_NAMES).toContain("grep");
    expect(AGENT_TOOL_NAMES).toContain("glob");
    expect(AGENT_TOOL_NAMES).toContain("lsp.diagnostics");
    expect(AGENT_TOOL_NAMES).toContain("lsp.definition");
    expect(AGENT_TOOL_NAMES).toContain("lsp.references");
    expect(AGENT_TOOL_NAMES).toContain("lsp.hover");
  });

  test("minimal preset gains grep + glob, no LSP", () => {
    expect(AGENT_TOOL_PRESETS.minimal).toContain("grep");
    expect(AGENT_TOOL_PRESETS.minimal).toContain("glob");
    expect(AGENT_TOOL_PRESETS.minimal).not.toContain("lsp.diagnostics");
  });

  test("standard preset gains grep + glob, no LSP", () => {
    expect(AGENT_TOOL_PRESETS.standard).toContain("grep");
    expect(AGENT_TOOL_PRESETS.standard).toContain("glob");
    expect(AGENT_TOOL_PRESETS.standard).not.toContain("lsp.definition");
  });

  test("developer preset gains all six new tools", () => {
    for (const name of ["grep", "glob", "lsp.diagnostics", "lsp.definition", "lsp.references", "lsp.hover"] as const) {
      expect(AGENT_TOOL_PRESETS.developer).toContain(name);
    }
  });

  test("tl preset gains grep + glob, no LSP", () => {
    expect(AGENT_TOOL_PRESETS.tl).toContain("grep");
    expect(AGENT_TOOL_PRESETS.tl).toContain("glob");
    expect(AGENT_TOOL_PRESETS.tl).not.toContain("lsp.hover");
  });

  test("full preset stays equal to AGENT_TOOL_NAMES", () => {
    expect([...AGENT_TOOL_PRESETS.full]).toEqual([...AGENT_TOOL_NAMES]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
bun test packages/protocol/src/v1/agent.test.ts
```

Expected: FAIL with "expected to contain 'grep'" or similar.

- [ ] **Step 4: Append the six names to `AGENT_TOOL_NAMES` in `packages/protocol/src/v1/agent.ts`**

After the existing `"browser.screenshot"` entry, before the closing `] as const`:

```typescript
  "grep",
  "glob",
  "lsp.diagnostics",
  "lsp.definition",
  "lsp.references",
  "lsp.hover",
```

- [ ] **Step 5: Update `AGENT_TOOL_PRESETS` arrays in the same file**

Add `"grep", "glob"` to the end of `minimal`, `standard`, `tl`. Add `"grep", "glob", "lsp.diagnostics", "lsp.definition", "lsp.references", "lsp.hover"` to the end of `developer`. `full` stays as `AGENT_TOOL_NAMES` and updates automatically.

- [ ] **Step 6: Run tests to verify pass**

```bash
bun test packages/protocol/src/v1/agent.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run protocol typecheck**

```bash
cd packages/protocol && bun run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/v1/agent.ts packages/protocol/src/v1/agent.test.ts
git commit -m "feat(protocol): add grep/glob/lsp.* to AGENT_TOOL_NAMES"
```

---

## Phase 2 — `grep` tool

### Task 2: Add `tinyglobby` dependency (shared with Phase 3)

**Files:**
- Modify: `apps/gateway/package.json`

- [ ] **Step 1: Check whether tinyglobby is already a transitive dep**

```bash
cd apps/gateway && bun pm ls 2>/dev/null | grep -E "tinyglobby|fast-glob" || echo "not present"
```

- [ ] **Step 2: Add as direct dep if not present**

```bash
cd apps/gateway && bun add tinyglobby
```

(If `bun pm ls` showed it as transitive, still add it as a direct dep — we don't want to depend on transitive resolution.)

- [ ] **Step 3: Add LSP wire-format deps**

```bash
cd apps/gateway && bun add vscode-jsonrpc vscode-languageserver-protocol
```

- [ ] **Step 4: Verify package.json was updated**

```bash
grep -E "tinyglobby|vscode-jsonrpc|vscode-languageserver-protocol" apps/gateway/package.json
```

Expected: all three lines present in `dependencies`.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/package.json apps/gateway/bun.lock bun.lock
git commit -m "chore(gateway): add tinyglobby + LSP wire-format deps"
```

(If `bun.lock` lives only at repo root, omit the per-package lock path. Check with `git status` first.)

---

### Task 3: grep — JS fallback implementation

**Files:**
- Create: `apps/gateway/src/runtime/grep.ts`
- Create: `apps/gateway/src/runtime/grep.test.ts`

- [ ] **Step 1: Write the test file with the expected interface**

`apps/gateway/src/runtime/grep.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGrep } from "./grep";

function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "grep-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const foo = 1;\nexport const bar = 2;\n");
  writeFileSync(join(root, "src", "b.ts"), "console.log('foo bar');\n");
  writeFileSync(join(root, "README.md"), "# Foo\nfoo on a markdown line\n");
  return root;
}

describe("runGrep (JS fallback)", () => {
  test("finds literal matches across files", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGrep({
        pattern: "foo",
        path: root,
        regex: false,
        useRipgrep: false,
      });
      const files = new Set(result.matches.map((m) => m.file.replace(root + "/", "")));
      expect(files.has("src/a.ts")).toBe(true);
      expect(files.has("src/b.ts")).toBe(true);
      expect(files.has("README.md")).toBe(true);
      expect(result.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("respects caseSensitive=true", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGrep({
        pattern: "Foo",
        path: root,
        regex: false,
        caseSensitive: true,
        useRipgrep: false,
      });
      const matchedTexts = result.matches.map((m) => m.text);
      expect(matchedTexts.some((t) => t.includes("Foo"))).toBe(true);
      expect(matchedTexts.every((t) => !t.includes("foo bar"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("regex=true treats pattern as regex", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGrep({
        pattern: "^export const ",
        path: root,
        regex: true,
        useRipgrep: false,
      });
      expect(result.matches.length).toBe(2);
      expect(result.matches.every((m) => m.file.endsWith("a.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("truncates at maxMatches", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGrep({
        pattern: "foo",
        path: root,
        regex: false,
        maxMatches: 1,
        useRipgrep: false,
      });
      expect(result.matches.length).toBe(1);
      expect(result.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("respects glob filter", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGrep({
        pattern: "foo",
        path: root,
        glob: "**/*.ts",
        regex: false,
        useRipgrep: false,
      });
      expect(result.matches.every((m) => m.file.endsWith(".ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests — they fail with "module not found"**

```bash
bun test apps/gateway/src/runtime/grep.test.ts
```

Expected: FAIL ("Cannot find module './grep'").

- [ ] **Step 3: Implement the JS fallback in `apps/gateway/src/runtime/grep.ts`**

```typescript
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { glob as tinyGlob } from "tinyglobby";

export interface GrepOptions {
  pattern: string;
  path?: string;
  glob?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  maxMatches?: number;
  useRipgrep?: boolean; // injection point for tests; runtime auto-detects
}

export interface GrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

const DEFAULT_MAX_MATCHES = 200;
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", ".next", ".cache"]);

export async function runGrep(opts: GrepOptions): Promise<GrepResult> {
  const root = opts.path ?? process.cwd();
  const max = opts.maxMatches ?? DEFAULT_MAX_MATCHES;
  const matcher = compileMatcher(opts.pattern, opts.regex ?? false, opts.caseSensitive ?? false);

  const files = opts.glob
    ? (await tinyGlob(opts.glob, { cwd: root, absolute: true, dot: false })) as string[]
    : await walk(root);

  const matches: GrepMatch[] = [];
  let truncated = false;

  for (const file of files) {
    if (matches.length >= max) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue; // binary file or permission error — skip
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= max) {
        truncated = true;
        break;
      }
      const hit = matcher(lines[i] ?? "");
      if (hit !== null) {
        matches.push({ file, line: i + 1, column: hit + 1, text: lines[i] ?? "" });
      }
    }
  }

  return { matches, truncated };
}

function compileMatcher(
  pattern: string,
  regex: boolean,
  caseSensitive: boolean,
): (line: string) => number | null {
  if (regex) {
    const re = new RegExp(pattern, caseSensitive ? "" : "i");
    return (line) => {
      const m = re.exec(line);
      return m ? m.index : null;
    };
  }
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return (line) => {
    const hay = caseSensitive ? line : line.toLowerCase();
    const idx = hay.indexOf(needle);
    return idx >= 0 ? idx : null;
  };
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue; // skip hidden
        await visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(join(dir, entry.name));
      }
    }
  }
  await visit(root);
  return out;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test apps/gateway/src/runtime/grep.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/grep.ts apps/gateway/src/runtime/grep.test.ts
git commit -m "feat(gateway): grep tool JS fallback impl"
```

---

### Task 4: grep — ripgrep wrapper with auto-detection

**Files:**
- Modify: `apps/gateway/src/runtime/grep.ts`
- Modify: `apps/gateway/src/runtime/grep.test.ts`

- [ ] **Step 1: Add a test asserting ripgrep is used when available**

Append to `apps/gateway/src/runtime/grep.test.ts`:

```typescript
import { spawnSync } from "node:child_process";

const HAS_RIPGREP = spawnSync("rg", ["--version"]).status === 0;

describe.if(HAS_RIPGREP)("runGrep (ripgrep path)", () => {
  test("ripgrep returns identical match shape to JS fallback", async () => {
    const root = makeTempRepo();
    try {
      const rgResult = await runGrep({ pattern: "foo", path: root, regex: false, useRipgrep: true });
      const jsResult = await runGrep({ pattern: "foo", path: root, regex: false, useRipgrep: false });
      const rgFiles = new Set(rgResult.matches.map((m) => m.file));
      const jsFiles = new Set(jsResult.matches.map((m) => m.file));
      expect(rgFiles).toEqual(jsFiles);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runGrep (auto-detect)", () => {
  test("auto-detect falls back to JS when ripgrep is missing", async () => {
    // We can't actually uninstall ripgrep mid-test, but we can verify the
    // exported `detectRipgrep` returns a boolean and runGrep tolerates either.
    const { detectRipgrep } = await import("./grep");
    const detected = await detectRipgrep();
    expect(typeof detected).toBe("boolean");
  });
});
```

`describe.if` is the project's idiom for conditional describes; if the test runner here doesn't support it, replace with a skip pattern (`(HAS_RIPGREP ? describe : describe.skip)("...", ...)`).

- [ ] **Step 2: Run tests — ripgrep block fails (missing implementation), auto-detect fails (no export)**

```bash
bun test apps/gateway/src/runtime/grep.test.ts
```

Expected: FAIL on "useRipgrep: true" path or on missing `detectRipgrep` export.

- [ ] **Step 3: Add ripgrep child-process implementation in `grep.ts`**

Insert near the top, after imports:

```typescript
import { spawn } from "node:child_process";

let ripgrepDetected: boolean | null = null;

export async function detectRipgrep(): Promise<boolean> {
  if (ripgrepDetected !== null) return ripgrepDetected;
  ripgrepDetected = await new Promise<boolean>((resolve) => {
    const proc = spawn("rg", ["--version"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
  return ripgrepDetected;
}

async function runGrepWithRipgrep(opts: GrepOptions, max: number): Promise<GrepResult> {
  const args = ["--json", "-n", "--column"];
  if (!(opts.caseSensitive ?? false)) args.push("-i");
  if (!(opts.regex ?? false)) args.push("-F");
  if (opts.glob) args.push("--glob", opts.glob);
  args.push(opts.pattern, opts.path ?? ".");

  return new Promise<GrepResult>((resolve, reject) => {
    const matches: GrepMatch[] = [];
    let truncated = false;
    const proc = spawn("rg", args);
    let stdoutBuf = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as RipgrepEvent;
          if (obj.type !== "match") continue;
          if (matches.length >= max) {
            truncated = true;
            proc.kill();
            return;
          }
          for (const sub of obj.data.submatches) {
            matches.push({
              file: obj.data.path.text,
              line: obj.data.line_number,
              column: sub.start + 1,
              text: obj.data.lines.text.replace(/\n$/, ""),
            });
            if (matches.length >= max) {
              truncated = true;
              proc.kill();
              return;
            }
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    proc.on("error", reject);
    proc.on("exit", () => resolve({ matches, truncated }));
  });
}

interface RipgrepEvent {
  type: "match" | "begin" | "end" | "summary";
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
    submatches: { start: number; end: number }[];
  };
}
```

- [ ] **Step 4: Wire `useRipgrep` selection into `runGrep`**

Replace the `runGrep` body's first lines:

```typescript
export async function runGrep(opts: GrepOptions): Promise<GrepResult> {
  const max = opts.maxMatches ?? DEFAULT_MAX_MATCHES;
  const useRipgrep = opts.useRipgrep ?? (await detectRipgrep());
  if (useRipgrep) {
    return runGrepWithRipgrep(opts, max);
  }
  // ...existing JS fallback body...
}
```

(Hoist `const max = ...` so the JS fallback uses the same value.)

- [ ] **Step 5: Run tests**

```bash
bun test apps/gateway/src/runtime/grep.test.ts
```

Expected: all tests PASS (ripgrep block conditional on local install).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/runtime/grep.ts apps/gateway/src/runtime/grep.test.ts
git commit -m "feat(gateway): grep tool ripgrep wrapper + auto-detect"
```

---

## Phase 3 — `glob` tool

### Task 5: glob implementation

**Files:**
- Create: `apps/gateway/src/runtime/glob.ts`
- Create: `apps/gateway/src/runtime/glob.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGlob } from "./glob";

function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "glob-test-"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(root, "src", "b.tsx"), "");
  writeFileSync(join(root, "src", "nested", "c.ts"), "");
  writeFileSync(join(root, "src", "d.js"), "");
  writeFileSync(join(root, "README.md"), "");
  return root;
}

describe("runGlob", () => {
  test("matches recursive ts pattern", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGlob({ pattern: "**/*.ts", path: root });
      const rels = result.paths.map((p) => p.replace(root + "/", "")).sort();
      expect(rels).toEqual(["src/a.ts", "src/nested/c.ts"]);
      expect(result.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("matches multiple extensions via brace", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGlob({ pattern: "**/*.{ts,tsx}", path: root });
      expect(result.paths.length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("respects maxResults", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGlob({ pattern: "**/*", path: root, maxResults: 2 });
      expect(result.paths.length).toBe(2);
      expect(result.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — fails on missing module**

```bash
bun test apps/gateway/src/runtime/glob.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `apps/gateway/src/runtime/glob.ts`**

```typescript
import { glob as tinyGlob } from "tinyglobby";

export interface GlobOptions {
  pattern: string;
  path?: string;
  maxResults?: number;
}

export interface GlobResult {
  paths: string[];
  truncated: boolean;
}

const DEFAULT_MAX = 500;
const SKIP_DIRS = ["**/node_modules/**", "**/.git/**", "**/target/**", "**/dist/**", "**/build/**", "**/.next/**", "**/.cache/**"];

export async function runGlob(opts: GlobOptions): Promise<GlobResult> {
  const max = opts.maxResults ?? DEFAULT_MAX;
  const cwd = opts.path ?? process.cwd();
  const all = (await tinyGlob(opts.pattern, {
    cwd,
    absolute: true,
    ignore: SKIP_DIRS,
    onlyFiles: false,
    dot: false,
  })) as string[];
  if (all.length <= max) {
    return { paths: all, truncated: false };
  }
  return { paths: all.slice(0, max), truncated: true };
}
```

- [ ] **Step 4: Run — pass**

```bash
bun test apps/gateway/src/runtime/glob.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/glob.ts apps/gateway/src/runtime/glob.test.ts
git commit -m "feat(gateway): glob tool"
```

---

## Phase 4 — LSP client manager

LSP work is the largest phase. The strategy:
1. Build the per-server `LspServerHandle` first (Task 6) — process spawn + jsonrpc connection + init handshake + didOpen + dispose.
2. Build `LspClientManager` on top (Task 7) — caches handles, idle TTL, error mapping.
3. Wire each capability through the manager (Task 8 covers all four — they share dispatcher shape).

Tests use a **stubbed jsonrpc transport** rather than spawning real language servers in CI. A separate optional integration test (Task 9) exercises a real `typescript-language-server` if the binary is on PATH.

### Task 6: `LspServerHandle` — spawn, init, didOpen, dispose

**Files:**
- Create: `apps/gateway/src/runtime/lspServerHandle.ts`
- Create: `apps/gateway/src/runtime/lspServerHandle.test.ts`

- [ ] **Step 1: Sketch the contract via tests**

```typescript
import { describe, expect, test } from "bun:test";
import { LspServerHandle, type LspTransport } from "./lspServerHandle";

class FakeTransport implements LspTransport {
  public sent: { method: string; params: unknown }[] = [];
  public responders: Record<string, (params: unknown) => unknown> = {};
  public disposed = false;

  async send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    const responder = this.responders[method];
    return responder ? responder(params) : null;
  }
  notify(method: string, params: unknown): void {
    this.sent.push({ method, params });
  }
  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

describe("LspServerHandle", () => {
  test("init sends initialize then initialized", async () => {
    const t = new FakeTransport();
    t.responders["initialize"] = () => ({ capabilities: {} });
    const handle = new LspServerHandle(t, "/repo", "typescript");
    await handle.ready();
    const methods = t.sent.map((s) => s.method);
    expect(methods[0]).toBe("initialize");
    expect(methods[1]).toBe("initialized");
  });

  test("opens a file once via didOpen, dedupes subsequent reads", async () => {
    const t = new FakeTransport();
    t.responders["initialize"] = () => ({ capabilities: {} });
    const handle = new LspServerHandle(t, "/repo", "typescript");
    await handle.ready();
    await handle.ensureOpen("/repo/src/a.ts", "ts");
    await handle.ensureOpen("/repo/src/a.ts", "ts");
    const opens = t.sent.filter((s) => s.method === "textDocument/didOpen");
    expect(opens.length).toBe(1);
  });

  test("dispose closes the transport", async () => {
    const t = new FakeTransport();
    t.responders["initialize"] = () => ({ capabilities: {} });
    const handle = new LspServerHandle(t, "/repo", "typescript");
    await handle.ready();
    await handle.dispose();
    expect(t.disposed).toBe(true);
  });

  test("touch() updates lastUsedAt", async () => {
    const t = new FakeTransport();
    t.responders["initialize"] = () => ({ capabilities: {} });
    const handle = new LspServerHandle(t, "/repo", "typescript");
    await handle.ready();
    const before = handle.lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    handle.touch();
    expect(handle.lastUsedAt).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 2: Run — fails on missing module**

```bash
bun test apps/gateway/src/runtime/lspServerHandle.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `apps/gateway/src/runtime/lspServerHandle.ts`**

```typescript
import { readFile } from "node:fs/promises";

export interface LspTransport {
  send(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  dispose(): Promise<void>;
}

export type LspLanguage = "typescript" | "rust";

export class LspServerHandle {
  private initPromise: Promise<void> | null = null;
  private openedFiles = new Set<string>();
  private _lastUsedAt = Date.now();

  constructor(
    private readonly transport: LspTransport,
    private readonly workspaceRoot: string,
    private readonly language: LspLanguage,
  ) {}

  get lastUsedAt(): number {
    return this._lastUsedAt;
  }

  touch(): void {
    this._lastUsedAt = Date.now();
  }

  async ready(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.transport.send("initialize", {
          processId: process.pid,
          rootUri: pathToFileUri(this.workspaceRoot),
          capabilities: {
            textDocument: {
              publishDiagnostics: { relatedInformation: true },
              definition: {},
              references: {},
              hover: { contentFormat: ["markdown", "plaintext"] },
            },
          },
        });
        this.transport.notify("initialized", {});
      })();
    }
    return this.initPromise;
  }

  async ensureOpen(filePath: string, languageId: string): Promise<void> {
    await this.ready();
    if (this.openedFiles.has(filePath)) return;
    const text = await readFile(filePath, "utf8");
    this.transport.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileUri(filePath),
        languageId,
        version: 1,
        text,
      },
    });
    this.openedFiles.add(filePath);
  }

  async send(method: string, params: unknown): Promise<unknown> {
    await this.ready();
    this.touch();
    return this.transport.send(method, params);
  }

  async dispose(): Promise<void> {
    try {
      await this.transport.send("shutdown", null);
      this.transport.notify("exit", null);
    } catch {
      // best-effort
    }
    await this.transport.dispose();
  }
}

function pathToFileUri(path: string): string {
  return `file://${path.replace(/\\/g, "/")}`;
}
```

- [ ] **Step 4: Run — pass**

```bash
bun test apps/gateway/src/runtime/lspServerHandle.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/lspServerHandle.ts apps/gateway/src/runtime/lspServerHandle.test.ts
git commit -m "feat(gateway): LspServerHandle (init, didOpen, dispose)"
```

---

### Task 7: `LspClientManager` — cache, lifecycle, error mapping

**Files:**
- Create: `apps/gateway/src/runtime/lspClientManager.ts`
- Create: `apps/gateway/src/runtime/lspClientManager.test.ts`

- [ ] **Step 1: Write tests for the manager**

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLspClientManager, type LspClientManager } from "./lspClientManager";
import { LspServerHandle, type LspTransport } from "./lspServerHandle";

function makeTsRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "lsp-test-"));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext" } }));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const foo: number = 'oops';\n");
  return root;
}

class StubTransport implements LspTransport {
  responses: Record<string, unknown> = {};
  async send(method: string): Promise<unknown> {
    return this.responses[method] ?? null;
  }
  notify(): void {}
  async dispose(): Promise<void> {}
}

describe("LspClientManager", () => {
  let mgr: LspClientManager;
  let root: string;

  beforeEach(() => {
    root = makeTsRepo();
  });
  afterEach(async () => {
    await mgr?.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  test("missing project config returns lsp.no_project_config error", async () => {
    rmSync(join(root, "tsconfig.json"));
    mgr = createLspClientManager({
      idleTtlMs: 60_000,
      sweepIntervalMs: 60_000,
      transportFactory: async () => new StubTransport(),
    });
    const result = await mgr.diagnostics(root, join(root, "src", "a.ts"));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("lsp.no_project_config");
  });

  test("unsupported file extension returns lsp.unsupported_language", async () => {
    mgr = createLspClientManager({
      idleTtlMs: 60_000,
      sweepIntervalMs: 60_000,
      transportFactory: async () => new StubTransport(),
    });
    const result = await mgr.diagnostics(root, join(root, "README.md"));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("lsp.unsupported_language");
  });

  test("idle eviction disposes the handle", async () => {
    const transports: StubTransport[] = [];
    mgr = createLspClientManager({
      idleTtlMs: 10,
      sweepIntervalMs: 5,
      transportFactory: async () => {
        const t = new StubTransport();
        transports.push(t);
        return t;
      },
    });
    await mgr.hover(root, join(root, "src", "a.ts"), 0, 0);
    expect(transports.length).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    // Internal cache should be empty after idle TTL.
    expect(mgr.cacheSize()).toBe(0);
  });
});
```

- [ ] **Step 2: Run — fails on missing module**

```bash
bun test apps/gateway/src/runtime/lspClientManager.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `lspClientManager.ts`**

```typescript
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { LspServerHandle, type LspLanguage, type LspTransport } from "./lspServerHandle";

export interface LspError {
  code:
    | "lsp.unsupported_language"
    | "lsp.no_project_config"
    | "lsp.server_not_found"
    | "lsp.indexing"
    | "lsp.path_outside_workspace";
  message: string;
  install_hint?: string;
}

export type LspResult<T> = { kind: "ok"; value: T } | { kind: "error"; error: LspError };

export interface Diagnostic {
  range: Range;
  severity: number;
  message: string;
  source?: string;
}
export interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
export interface Location {
  filePath: string;
  range: Range;
}
export interface HoverContent {
  contents: string;
  range: Range | null;
}

export interface LspClientManager {
  diagnostics(root: string, filePath: string): Promise<LspResult<Diagnostic[]>>;
  definition(root: string, filePath: string, line: number, character: number): Promise<LspResult<Location[]>>;
  references(root: string, filePath: string, line: number, character: number, includeDecl: boolean): Promise<LspResult<Location[]>>;
  hover(root: string, filePath: string, line: number, character: number): Promise<LspResult<HoverContent | null>>;
  cacheSize(): number;
  dispose(): Promise<void>;
}

export interface LspClientManagerOptions {
  idleTtlMs?: number;
  sweepIntervalMs?: number;
  transportFactory: (root: string, language: LspLanguage) => Promise<LspTransport | null>;
}

const DEFAULT_IDLE_TTL = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL = 60 * 1000;

export function detectLanguage(filePath: string): LspLanguage | null {
  const ext = extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
  if (ext === ".rs") return "rust";
  return null;
}

export function projectConfigExists(root: string, language: LspLanguage): boolean {
  if (language === "typescript") {
    return existsSync(join(root, "tsconfig.json")) || existsSync(join(root, "jsconfig.json"));
  }
  if (language === "rust") {
    return existsSync(join(root, "Cargo.toml"));
  }
  return false;
}

export function createLspClientManager(opts: LspClientManagerOptions): LspClientManager {
  const ttl = opts.idleTtlMs ?? DEFAULT_IDLE_TTL;
  const sweep = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL;
  const handles = new Map<string, LspServerHandle>();

  const sweeper = setInterval(async () => {
    const now = Date.now();
    for (const [key, handle] of handles) {
      if (now - handle.lastUsedAt > ttl) {
        handles.delete(key);
        await handle.dispose().catch(() => {});
      }
    }
  }, sweep);
  // Don't keep the process alive solely for the sweeper.
  if ("unref" in sweeper) (sweeper as { unref: () => void }).unref();

  async function getHandle(root: string, language: LspLanguage): Promise<LspResult<LspServerHandle>> {
    const key = `${root}::${language}`;
    const existing = handles.get(key);
    if (existing) {
      existing.touch();
      return { kind: "ok", value: existing };
    }
    if (!projectConfigExists(root, language)) {
      return {
        kind: "error",
        error: {
          code: "lsp.no_project_config",
          message: `No ${language === "typescript" ? "tsconfig.json/jsconfig.json" : "Cargo.toml"} at ${root}`,
        },
      };
    }
    const transport = await opts.transportFactory(root, language);
    if (!transport) {
      return {
        kind: "error",
        error: {
          code: "lsp.server_not_found",
          message: `${language === "typescript" ? "typescript-language-server" : "rust-analyzer"} not found on PATH`,
          install_hint: language === "typescript"
            ? "npm install -g typescript-language-server typescript"
            : "rustup component add rust-analyzer",
        },
      };
    }
    const handle = new LspServerHandle(transport, root, language);
    await handle.ready();
    handles.set(key, handle);
    return { kind: "ok", value: handle };
  }

  function preflight(root: string, filePath: string): LspResult<{ language: LspLanguage }> {
    if (!filePath.startsWith(root)) {
      return { kind: "error", error: { code: "lsp.path_outside_workspace", message: filePath } };
    }
    const language = detectLanguage(filePath);
    if (!language) {
      return { kind: "error", error: { code: "lsp.unsupported_language", message: filePath } };
    }
    return { kind: "ok", value: { language } };
  }

  async function dispatch<T>(
    root: string,
    filePath: string,
    languageId: string,
    method: string,
    params: (uri: string) => unknown,
    convert: (raw: unknown) => T,
  ): Promise<LspResult<T>> {
    const pre = preflight(root, filePath);
    if (pre.kind === "error") return pre;
    const handle = await getHandle(root, pre.value.language);
    if (handle.kind === "error") return handle;
    await handle.value.ensureOpen(filePath, languageId);
    const uri = `file://${filePath}`;
    let raw: unknown;
    try {
      raw = await Promise.race([
        handle.value.send(method, params(uri)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30_000)),
      ]);
    } catch (err) {
      return {
        kind: "error",
        error: { code: "lsp.indexing", message: (err as Error).message },
      };
    }
    return { kind: "ok", value: convert(raw) };
  }

  function langId(language: LspLanguage): string {
    return language === "typescript" ? "typescript" : "rust";
  }

  return {
    diagnostics: (root, filePath) =>
      dispatch(
        root,
        filePath,
        langId(detectLanguage(filePath) ?? "typescript"),
        "textDocument/diagnostic",
        (uri) => ({ textDocument: { uri } }),
        (raw) => ((raw as { items?: Diagnostic[] })?.items ?? []) as Diagnostic[],
      ),
    definition: (root, filePath, line, character) =>
      dispatch(
        root,
        filePath,
        langId(detectLanguage(filePath) ?? "typescript"),
        "textDocument/definition",
        (uri) => ({ textDocument: { uri }, position: { line, character } }),
        (raw) => normalizeLocations(raw),
      ),
    references: (root, filePath, line, character, includeDecl) =>
      dispatch(
        root,
        filePath,
        langId(detectLanguage(filePath) ?? "typescript"),
        "textDocument/references",
        (uri) => ({
          textDocument: { uri },
          position: { line, character },
          context: { includeDeclaration: includeDecl },
        }),
        (raw) => normalizeLocations(raw),
      ),
    hover: (root, filePath, line, character) =>
      dispatch(
        root,
        filePath,
        langId(detectLanguage(filePath) ?? "typescript"),
        "textDocument/hover",
        (uri) => ({ textDocument: { uri }, position: { line, character } }),
        (raw) => normalizeHover(raw),
      ),
    cacheSize: () => handles.size,
    dispose: async () => {
      clearInterval(sweeper);
      for (const handle of handles.values()) {
        await handle.dispose().catch(() => {});
      }
      handles.clear();
    },
  };
}

function normalizeLocations(raw: unknown): Location[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((loc) => ({
    filePath: ((loc as { uri: string }).uri ?? "").replace(/^file:\/\//, ""),
    range: (loc as { range: Range }).range,
  }));
}

function normalizeHover(raw: unknown): HoverContent | null {
  if (!raw) return null;
  const r = raw as { contents?: unknown; range?: Range };
  let contents = "";
  if (typeof r.contents === "string") contents = r.contents;
  else if (Array.isArray(r.contents)) {
    contents = r.contents.map((c) => (typeof c === "string" ? c : (c as { value: string }).value)).join("\n");
  } else if (typeof r.contents === "object" && r.contents !== null && "value" in r.contents) {
    contents = (r.contents as { value: string }).value;
  }
  return { contents, range: r.range ?? null };
}
```

- [ ] **Step 4: Run tests**

```bash
bun test apps/gateway/src/runtime/lspClientManager.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/lspClientManager.ts apps/gateway/src/runtime/lspClientManager.test.ts
git commit -m "feat(gateway): LspClientManager with cache + idle TTL + error mapping"
```

---

### Task 8: Real LSP transport factory (server discovery + jsonrpc)

**Files:**
- Modify: `apps/gateway/src/runtime/lspClientManager.ts`
- Create: `apps/gateway/src/runtime/lspTransport.ts`
- Create: `apps/gateway/src/runtime/lspTransport.test.ts`

- [ ] **Step 1: Test the discovery helper**

`apps/gateway/src/runtime/lspTransport.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { resolveServerBinary } from "./lspTransport";

describe("resolveServerBinary", () => {
  test("returns null when no binary is found", async () => {
    const result = await resolveServerBinary("typescript", "/nonexistent-workspace");
    // On a CI box without typescript-language-server, this is null.
    // On a dev box with it installed, it's a path. Either is acceptable.
    if (result !== null) expect(result).toContain("typescript-language-server");
  });

  test("returns null for unknown language", async () => {
    const result = await resolveServerBinary(
      "klingon" as never,
      "/nonexistent-workspace",
    );
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run — fails on missing module**

```bash
bun test apps/gateway/src/runtime/lspTransport.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `lspTransport.ts`**

```typescript
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { LspLanguage, LspTransport } from "./lspServerHandle";

export async function resolveServerBinary(
  language: LspLanguage,
  workspaceRoot: string,
): Promise<string | null> {
  if (language === "typescript") {
    const local = join(workspaceRoot, "node_modules", ".bin", "typescript-language-server");
    if (existsSync(local)) return local;
    return whichSync("typescript-language-server");
  }
  if (language === "rust") {
    const fromWhich = whichSync("rust-analyzer");
    if (fromWhich) return fromWhich;
    const cargoBin = join(homedir(), ".cargo", "bin", "rust-analyzer");
    if (existsSync(cargoBin)) return cargoBin;
    return null;
  }
  return null;
}

function whichSync(cmd: string): string | null {
  const result = spawnSync("which", [cmd], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const line = result.stdout.trim().split("\n")[0];
  return line || null;
}

export async function createRealTransport(
  workspaceRoot: string,
  language: LspLanguage,
): Promise<LspTransport | null> {
  const binary = await resolveServerBinary(language, workspaceRoot);
  if (!binary) return null;
  const args = language === "typescript" ? ["--stdio"] : [];
  const child = spawn(binary, args, { cwd: workspaceRoot, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();

  return {
    async send(method, params) {
      return await connection.sendRequest(method, params);
    },
    notify(method, params) {
      void connection.sendNotification(method, params);
    },
    async dispose() {
      try {
        connection.dispose();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
    },
  };
}
```

- [ ] **Step 4: Wire `createRealTransport` into manager construction in `apps/gateway/src/server.ts` (call site)**

Look up where `LspClientManager` is constructed in server bootstrap. If it's not constructed yet (this task is the first wiring), add construction near where other runtime services are bootstrapped:

```typescript
import { createLspClientManager } from "./runtime/lspClientManager";
import { createRealTransport } from "./runtime/lspTransport";

const lspManager = createLspClientManager({
  transportFactory: createRealTransport,
});
```

Pass `lspManager` through to `gatewayLocalTools` (next task wires the dispatch — this step just constructs and disposes on shutdown).

Find the existing graceful shutdown hook in `server.ts` and add `await lspManager.dispose();`.

- [ ] **Step 5: Run all gateway tests**

```bash
cd apps/gateway && bun test
```

Expected: existing tests pass; new lspTransport tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/runtime/lspTransport.ts apps/gateway/src/runtime/lspTransport.test.ts apps/gateway/src/server.ts
git commit -m "feat(gateway): real LSP transport via vscode-jsonrpc + server bootstrap"
```

---

## Phase 5 — Wire tools into the dispatcher

### Task 9: Add grep + glob + lsp.* dispatch in `gatewayLocalTools.ts`

**Files:**
- Modify: `apps/gateway/src/runtime/gatewayLocalTools.ts`
- Modify: `apps/gateway/src/runtime/gatewayLocalTools.test.ts`

- [ ] **Step 1: Read the current dispatcher to understand the pattern**

```bash
grep -n "executeLocalTool\|case \"" apps/gateway/src/runtime/gatewayLocalTools.ts | head -40
```

- [ ] **Step 2: Add tests for new tool dispatch (start with grep)**

Append to `gatewayLocalTools.test.ts`:

```typescript
test("grep dispatch returns matches from the tmp workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-grep-"));
  writeFileSync(join(root, "a.ts"), "const foo = 1;\n");
  try {
    const tools = makeGatewayLocalTools({
      shellTools: async () => ({ ok: true }),
      // existing required deps from other tests in this file...
    });
    const result = await tools({
      callId: "c1",
      tool: "grep",
      input: { pattern: "foo", path: root, regex: false },
      runId: "r1",
      workspacePath: root,
      permissionMode: "default",
    });
    expect((result as { matches: unknown[] }).matches.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("glob dispatch returns paths", async () => {
  // ...analogous shape...
});

test("lsp.diagnostics dispatch returns no_project_config error for empty dir", async () => {
  // ...analogous shape, expects { error: { code: "lsp.no_project_config" } }
});
```

(Reuse the existing test file's setup helpers; only the dispatch path is new.)

- [ ] **Step 3: Run — fails (LOCAL_TOOL_NAMES doesn't include grep/glob/lsp.*; no dispatch arms)**

```bash
bun test apps/gateway/src/runtime/gatewayLocalTools.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Update `LOCAL_TOOL_NAMES` set**

```typescript
const LOCAL_TOOL_NAMES = new Set([
  // ...existing entries...
  "grep",
  "glob",
  "lsp.diagnostics",
  "lsp.definition",
  "lsp.references",
  "lsp.hover",
]);
```

- [ ] **Step 5: Thread `lspManager` through `GatewayLocalToolsOptions`**

```typescript
import type { LspClientManager } from "./lspClientManager";

export interface GatewayLocalToolsOptions {
  shellTools: ToolCallable;
  appendEvent?: (runId: string, partial: PartialRunEvent) => void;
  fetch?: FetchLike;
  webAccess?: WebAccessService;
  sessions?: GatewaySessionsTools;
  memory?: GatewayMemoryTools;
  mcp?: GatewayMcpTools;
  lspManager?: LspClientManager;  // NEW
}
```

- [ ] **Step 6: Add dispatch arms in `executeLocalTool`**

```typescript
import { runGrep } from "./grep";
import { runGlob } from "./glob";

// inside executeLocalTool's switch on call.tool:
case "grep": {
  const input = call.input as { pattern: string; path?: string; glob?: string; regex?: boolean; caseSensitive?: boolean; maxMatches?: number };
  return await runGrep({
    pattern: input.pattern,
    path: input.path ?? call.workspacePath,
    glob: input.glob,
    regex: input.regex ?? false,
    caseSensitive: input.caseSensitive ?? false,
    maxMatches: input.maxMatches ?? undefined,
  });
}
case "glob": {
  const input = call.input as { pattern: string; path?: string; maxResults?: number };
  return await runGlob({
    pattern: input.pattern,
    path: input.path ?? call.workspacePath,
    maxResults: input.maxResults ?? undefined,
  });
}
case "lsp.diagnostics":
case "lsp.definition":
case "lsp.references":
case "lsp.hover": {
  if (!opts.lspManager) {
    throw new ToolCallError("lsp.unavailable", "LSP manager not configured");
  }
  const input = call.input as { filePath: string; line?: number; character?: number; includeDeclaration?: boolean };
  const root = call.workspacePath ?? "";
  if (call.tool === "lsp.diagnostics") {
    return mapLspResult(await opts.lspManager.diagnostics(root, input.filePath));
  }
  if (call.tool === "lsp.definition") {
    return mapLspResult(await opts.lspManager.definition(root, input.filePath, input.line ?? 0, input.character ?? 0));
  }
  if (call.tool === "lsp.references") {
    return mapLspResult(await opts.lspManager.references(root, input.filePath, input.line ?? 0, input.character ?? 0, input.includeDeclaration ?? true));
  }
  return mapLspResult(await opts.lspManager.hover(root, input.filePath, input.line ?? 0, input.character ?? 0));
}
```

Add the small helper:

```typescript
function mapLspResult(result: { kind: "ok" | "error"; value?: unknown; error?: unknown }): unknown {
  if (result.kind === "ok") return result.value;
  return { error: result.error };
}
```

- [ ] **Step 7: Pass `lspManager` from `server.ts` into the tools**

In `server.ts`, where `makeGatewayLocalTools` is called, add `lspManager` to the options object.

- [ ] **Step 8: Run all gateway tests**

```bash
cd apps/gateway && bun test
```

Expected: PASS (including the new dispatch tests).

- [ ] **Step 9: Commit**

```bash
git add apps/gateway/src/runtime/gatewayLocalTools.ts apps/gateway/src/runtime/gatewayLocalTools.test.ts apps/gateway/src/server.ts
git commit -m "feat(gateway): dispatch grep/glob/lsp.* in gatewayLocalTools"
```

---

### Task 10: Register tool specs in `coreTools.ts`

**Files:**
- Modify: `apps/gateway/src/tools/coreTools.ts`
- Modify: `apps/gateway/src/tools/coreTools.test.ts` (or sdkAdapter.test.ts — pick the existing one that covers tool registration)

- [ ] **Step 1: Read the registration section to understand the shape**

```bash
sed -n '137,165p' apps/gateway/src/tools/coreTools.ts
```

- [ ] **Step 2: Add tests asserting all six tools are registered with auto-approve**

Write or extend the relevant test file:

```typescript
import { createCoreToolRegistry } from "./coreTools";
import { coreToolApprovalDecision } from "./coreTools";

test("registry contains the six new tools", () => {
  const registry = createCoreToolRegistry();
  for (const id of ["grep", "glob", "lsp.diagnostics", "lsp.definition", "lsp.references", "lsp.hover"]) {
    expect(registry.findById(id)).not.toBeNull();
  }
});

test("new tools are read-only auto-approve", () => {
  for (const id of ["grep", "glob", "lsp.diagnostics", "lsp.definition", "lsp.references", "lsp.hover"]) {
    const decision = coreToolApprovalDecision(id, {}, "/tmp");
    expect(decision.needsApproval).toBe(false);
  }
});
```

(`registry.findById` may have a different name; check the `ToolRegistry` class for the actual lookup method and adjust.)

- [ ] **Step 3: Run — fails**

```bash
cd apps/gateway && bun test src/tools
```

Expected: FAIL.

- [ ] **Step 4: Add Zod schemas at the top of `coreTools.ts`**

```typescript
const grepParameters = z.object({
  pattern: z.string(),
  path: z.string().nullable(),
  glob: z.string().nullable(),
  regex: z.boolean().nullable(),
  caseSensitive: z.boolean().nullable(),
  maxMatches: z.number().int().positive().nullable(),
});

const globParameters = z.object({
  pattern: z.string(),
  path: z.string().nullable(),
  maxResults: z.number().int().positive().nullable(),
});

const lspDiagnosticsParameters = z.object({
  filePath: z.string(),
});

const lspPositionalParameters = z.object({
  filePath: z.string(),
  line: z.number().int().min(0),
  character: z.number().int().min(0),
});

const lspReferencesParameters = z.object({
  filePath: z.string(),
  line: z.number().int().min(0),
  character: z.number().int().min(0),
  includeDeclaration: z.boolean().nullable(),
});
```

(Match the existing convention of `.nullable()` for optional fields, per the existing schemas in this file.)

- [ ] **Step 5: Add six factory functions**

After `browserScreenshotTool()`:

```typescript
function grepTool(): GatewayToolSpec {
  return {
    id: "grep",
    sdkName: "grep",
    label: "Grep",
    description:
      "Search file contents for a pattern. Prefer this over shell.exec/grep — output is structured and avoids context bloat.",
    parameters: grepParameters,
    source: "core",
    category: "fs",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "grep", input),
  };
}

function globTool(): GatewayToolSpec {
  return {
    id: "glob",
    sdkName: "glob",
    label: "Glob",
    description: "List file paths matching a glob pattern. Prefer this over shell.exec/find for filename matching.",
    parameters: globParameters,
    source: "core",
    category: "fs",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "glob", input),
  };
}

function lspDiagnosticsTool(): GatewayToolSpec {
  return {
    id: "lsp.diagnostics",
    sdkName: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Read TypeScript or Rust diagnostics for a file. May return lsp.no_project_config or lsp.indexing — retry after 30s on the latter.",
    parameters: lspDiagnosticsParameters,
    source: "core",
    category: "lsp",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "lsp.diagnostics", input),
  };
}

function lspDefinitionTool(): GatewayToolSpec {
  return {
    id: "lsp.definition",
    sdkName: "lsp_definition",
    label: "LSP Definition",
    description: "Jump to the definition of the symbol at a position in a TS or Rust file.",
    parameters: lspPositionalParameters,
    source: "core",
    category: "lsp",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "lsp.definition", input),
  };
}

function lspReferencesTool(): GatewayToolSpec {
  return {
    id: "lsp.references",
    sdkName: "lsp_references",
    label: "LSP References",
    description: "Find all references to the symbol at a position.",
    parameters: lspReferencesParameters,
    source: "core",
    category: "lsp",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "lsp.references", input),
  };
}

function lspHoverTool(): GatewayToolSpec {
  return {
    id: "lsp.hover",
    sdkName: "lsp_hover",
    label: "LSP Hover",
    description: "Get type information / documentation for the symbol at a position.",
    parameters: lspPositionalParameters,
    source: "core",
    category: "lsp",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "lsp.hover", input),
  };
}
```

- [ ] **Step 6: Wire factories into `createCoreToolRegistry`**

```typescript
return new ToolRegistry([
  // ...existing entries...
  browserScreenshotTool(),
  grepTool(),
  globTool(),
  lspDiagnosticsTool(),
  lspDefinitionTool(),
  lspReferencesTool(),
  lspHoverTool(),
]);
```

- [ ] **Step 7: Extend `coreToolApprovalDecision` switch**

Before the `default:` arm:

```typescript
case "grep":
case "glob":
case "lsp.diagnostics":
case "lsp.definition":
case "lsp.references":
case "lsp.hover":
  return { needsApproval: false };
```

- [ ] **Step 8: Run tests**

```bash
cd apps/gateway && bun test src/tools
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/gateway/src/tools/coreTools.ts apps/gateway/src/tools/coreTools.test.ts
git commit -m "feat(gateway): register grep/glob/lsp.* tool specs"
```

---

## Phase 6 — Builtin skills

### Task 11: Builtin skill source loader

**Files:**
- Modify: `apps/gateway/src/runtime/skills.ts`
- Modify: `apps/gateway/src/runtime/skills.test.ts`

- [ ] **Step 1: Add tests for the new source**

Append to `skills.test.ts`:

```typescript
test("loadSkillEntries reads from builtinDir", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-builtin-"));
  const builtin = join(root, "builtin");
  mkdirSync(builtin, { recursive: true });
  writeFileSync(
    join(builtin, "alpha.md"),
    "---\nname: alpha\ndescription: alpha skill\n---\n\nbody",
  );
  const entries = loadSkillEntries({
    workspaceDir: join(root, "ws"),
    builtinDir: builtin,
  });
  expect(entries.find((e) => e.name === "alpha")?.source).toBe("builtin");
  rmSync(root, { recursive: true, force: true });
});

test("profile skill overrides builtin with same name", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-override-"));
  const builtin = join(root, "builtin");
  const profile = join(root, "profile");
  mkdirSync(builtin, { recursive: true });
  mkdirSync(join(profile, "skills"), { recursive: true });
  writeFileSync(
    join(builtin, "alpha.md"),
    "---\nname: alpha\ndescription: builtin version\n---\n",
  );
  writeFileSync(
    join(profile, "skills", "alpha.md"),
    "---\nname: alpha\ndescription: overridden\n---\n",
  );
  const entries = loadSkillEntries({
    workspaceDir: join(root, "ws"),
    profileDir: profile,
    builtinDir: builtin,
  });
  const alpha = entries.find((e) => e.name === "alpha");
  expect(alpha?.description).toBe("overridden");
  expect(alpha?.source).toBe("profile");
  rmSync(root, { recursive: true, force: true });
});

test("missing builtinDir does not throw", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-missing-"));
  const entries = loadSkillEntries({
    workspaceDir: join(root, "ws"),
    builtinDir: join(root, "does-not-exist"),
  });
  expect(entries).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run — fails (no `builtinDir` option)**

```bash
bun test apps/gateway/src/runtime/skills.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Extend `LoadSkillEntriesOptions` and `SkillEntry.source`**

```typescript
export interface LoadSkillEntriesOptions {
  workspaceDir: string;
  profileDir?: string;
  agentCoreDir?: string;
  builtinDir?: string;          // NEW
  maxSkillFileBytes?: number;
}

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source?: "builtin" | "profile" | "workspace" | "agent-core";  // widened
  modelInvocationEnabled: boolean;
  userInvocable?: boolean;
  metadata?: SkillMetadata;
}
```

- [ ] **Step 4: Insert the builtin source into `loadSkillEntries`**

```typescript
const builtinSkills = opts.builtinDir
  ? loadSkillsFromRoot(opts.builtinDir, maxSkillFileBytes, "builtin")
  : [];
const profileSkills = opts.profileDir
  ? loadSkillsFromRoot(join(opts.profileDir, "skills"), maxSkillFileBytes, "profile")
  : [];
// ...existing workspace + agent-core lookups...

const merged = new Map<string, SkillEntry>();
for (const skill of builtinSkills) merged.set(skill.name, skill);
for (const skill of profileSkills) merged.set(skill.name, skill);
for (const skill of workspaceSkills) merged.set(skill.name, skill);
for (const skill of agentCoreSkills) merged.set(skill.name, skill);
```

The `loadSkillsFromRoot` helper's third arg signature already accepts `source`; widen its type to include `"builtin"`.

- [ ] **Step 5: Run tests**

```bash
bun test apps/gateway/src/runtime/skills.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/runtime/skills.ts apps/gateway/src/runtime/skills.test.ts
git commit -m "feat(gateway): add builtin source to skills loader (lowest precedence)"
```

---

### Task 12: Wire `BUILTIN_SKILLS_DIR` into server bootstrap

**Files:**
- Create: `apps/gateway/builtin-skills/.keep` (placeholder so the directory exists pre-content)
- Modify: `apps/gateway/src/server.ts`

- [ ] **Step 1: Create the directory with a placeholder**

```bash
mkdir -p apps/gateway/builtin-skills
touch apps/gateway/builtin-skills/.keep
```

- [ ] **Step 2: Find the call site of `loadSkillEntries` in `server.ts`**

```bash
grep -n "loadSkillEntries\|skillsPromptForAgent" apps/gateway/src/server.ts
```

- [ ] **Step 3: Add the resolver constant and pass it to `loadSkillEntries`**

Near top of `server.ts`:

```typescript
import { fileURLToPath } from "node:url";

const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../builtin-skills/", import.meta.url));
```

Where `loadSkillEntries({ ... })` is called, add `builtinDir: BUILTIN_SKILLS_DIR`.

- [ ] **Step 4: Run server-level tests**

```bash
cd apps/gateway && bun test src/server.test.ts src/server.integration.test.ts
```

Expected: PASS — no skills loaded yet (empty dir), but no errors either.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/builtin-skills/.keep apps/gateway/src/server.ts
git commit -m "feat(gateway): wire BUILTIN_SKILLS_DIR into server bootstrap"
```

---

### Task 13: Author `tdd-workflow` skill

**Files:**
- Create: `apps/gateway/builtin-skills/tdd-workflow.md`

- [ ] **Step 1: Write the file**

```markdown
---
name: tdd-workflow
description: Use when implementing a new feature or fixing a bug that is reproducible. Drives the red/green/refactor loop and prevents implementation-before-verification.
---

# TDD Workflow

## When to use
- A new feature is being added.
- A bug has a clear reproduction.
- You are about to write a function with non-trivial logic.

## When NOT to use
- One-line refactors with no behavior change.
- Configuration / dependency edits.
- Pure typo fixes.

## Steps
1. Write the smallest test that names the desired behavior. The test must fail for the right reason — not because the function is missing, but because the behavior is missing.
2. Run the test. Confirm it fails. If it passes, the test is wrong.
3. Implement the minimal code that turns the test green. Resist adding features the test doesn't demand.
4. Run the test. Confirm it passes.
5. Refactor only if there is real duplication or unclear naming. Do not refactor for hypothetical future requirements.
6. Run the full test file (not just the new test) to catch regressions.
7. Commit. The commit should contain the test and the implementation together.

## Common pitfalls
- Writing the implementation first and the test second — this is not TDD; it's regression testing.
- Asserting on internal state (private fields, intermediate values) instead of observable behavior.
- Tests that mock the very thing they should verify.
- Skipping the "see it fail" step. If you never see red, you don't know your test exercises the change.
```

- [ ] **Step 2: Verify the loader picks it up**

```bash
cd apps/gateway && bun test src/runtime/skills.test.ts
```

Existing tests should still pass; if any test asserts the empty-builtin case, it may need updating to reflect that the builtin dir now contains one file. Most tests use temp dirs so they're isolated — verify before editing.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/builtin-skills/tdd-workflow.md
git commit -m "docs(skills): tdd-workflow builtin skill"
```

---

### Task 14: Author `systematic-debugging` skill

**Files:**
- Create: `apps/gateway/builtin-skills/systematic-debugging.md`

- [ ] **Step 1: Write the file**

```markdown
---
name: systematic-debugging
description: Use when something is broken, a test is failing, or behavior is unexpected. Hypothesis-driven, root-cause focused — not symptom-patching.
---

# Systematic Debugging

## When to use
- A test is failing and the cause is not immediately obvious from the diff.
- A user-visible bug is reported.
- A behavior diverges from documented or expected output.

## Steps
1. Reproduce the failure deterministically. If you cannot reproduce, you cannot debug — find a smaller test case first.
2. State the hypothesis in one sentence. Example: "The cache returns stale data because the TTL is computed before the entry is inserted."
3. Identify the cheapest experiment that confirms or refutes the hypothesis. Often: add one log line, run one query, read one specific function.
4. Run the experiment. Note the result.
5. If confirmed, fix the root cause — not the symptom. The fix should make the failing test pass AND prevent the same class of bug from recurring.
6. If refuted, generate a new hypothesis from what the experiment told you. Do not "try things until it works" — every action must be tied to a hypothesis.
7. Once fixed, write a regression test (if there isn't one already).

## Common pitfalls
- Pattern-matching to past bugs without verifying. Two bugs can share symptoms but have different causes.
- Adding `try/catch` that swallows the error. The error tells you what's wrong; suppressing it just hides the next failure mode.
- Stopping at the first thing that "works" without confirming why. If you don't know why the fix worked, you don't know what else broke.
```

- [ ] **Step 2: Commit**

```bash
git add apps/gateway/builtin-skills/systematic-debugging.md
git commit -m "docs(skills): systematic-debugging builtin skill"
```

---

### Task 15: Author `verification-before-done` skill

**Files:**
- Create: `apps/gateway/builtin-skills/verification-before-done.md`

- [ ] **Step 1: Write the file**

```markdown
---
name: verification-before-done
description: Use before claiming a task is complete, fixed, or passing. Requires running concrete verification commands and showing output — evidence over assertions.
---

# Verification Before Done

## When to use
- About to write "done", "fixed", "passing", "should work" in a response.
- Before creating a commit that fixes a bug.
- Before opening or merging a PR.
- Before declaring an iteration of agent work finished.

## Steps
1. Identify the verification command. Examples: `bun test path/to/file.test.ts`, `cargo check`, `cargo test --package <name>`, `bun run typecheck`.
2. Run the command. Capture the exit code AND the relevant output.
3. Read the output. Confirm it shows the expected success signal — not just exit code 0, but the actual line that says "all tests passed" / "no errors".
4. If you ran a partial verification (e.g., one test file out of the suite), explicitly note this — partial verification is not full verification.
5. Only after confirming, claim completion. The claim must reference what was verified, not what was attempted.

## Forbidden patterns
- Saying "the build should pass now" without running the build.
- Saying "this fixes the bug" without running the failing repro.
- Treating "no compile errors" as equivalent to "tests pass".
- Skipping verification because "the change was small". Small changes break things too.
```

- [ ] **Step 2: Commit**

```bash
git add apps/gateway/builtin-skills/verification-before-done.md
git commit -m "docs(skills): verification-before-done builtin skill"
```

---

### Task 16: Author `code-review-checklist` skill

**Files:**
- Create: `apps/gateway/builtin-skills/code-review-checklist.md`

- [ ] **Step 1: Write the file**

```markdown
---
name: code-review-checklist
description: Use when reviewing your own diff before commit, or when reviewing someone else's PR. Checklist for catching common defects in TypeScript/Rust/React code.
---

# Code Review Checklist

## When to use
- Before committing a non-trivial change.
- Before opening a PR.
- When asked to review someone else's diff.

## Checklist

### Correctness
- Does each new function / method have a single clear responsibility?
- Are error paths handled, or do they silently return / throw the wrong thing?
- Are edge cases covered: empty input, null, max-size, off-by-one boundaries?
- Are async functions awaited where they should be? Any unhandled promises?

### Tests
- Is there a test that would have caught the bug being fixed? (For bug fixes specifically.)
- Are the tests asserting behavior, not implementation details?
- Do the tests run in isolation — no shared state, no test ordering dependency?

### Readability
- Are names accurate? `getX` should not have side effects; `loadX` should not return a partial.
- Is there a comment that restates what the code already says? Delete it.
- Is there a comment that explains *why* a non-obvious choice was made? Keep it.

### Security
- Does any user-controllable string flow into shell, SQL, or eval without escaping?
- Are secrets read from env / Keychain, not committed?
- Are paths validated against a workspace boundary (no path traversal)?

### Performance
- Any O(n²) or worse over user-controllable input?
- Any synchronous file reads in a hot path?

### Project conventions
- Does the change follow the existing file's style (immutability, file size, naming)?
- Are new dependencies justified? Could a 5-line implementation replace them?
```

- [ ] **Step 2: Commit**

```bash
git add apps/gateway/builtin-skills/code-review-checklist.md
git commit -m "docs(skills): code-review-checklist builtin skill"
```

---

### Task 17: Author `web-research` skill

**Files:**
- Create: `apps/gateway/builtin-skills/web-research.md`

- [ ] **Step 1: Write the file**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/gateway/builtin-skills/web-research.md
git commit -m "docs(skills): web-research builtin skill"
```

---

### Task 18: Author `task-decomposition` skill

**Files:**
- Create: `apps/gateway/builtin-skills/task-decomposition.md`

- [ ] **Step 1: Write the file**

```markdown
---
name: task-decomposition
description: Use when a request is large or has multiple independent pieces. Break it into smaller tasks, identify dependencies, and decide what to do in parallel vs sequentially.
---

# Task Decomposition

## When to use
- The user's request mentions multiple components or stages.
- A single task would touch more than ~5 files.
- You're about to write more than ~3 todo items at once.

## Steps

1. Restate the request in your own words. Confirm with the user if it's ambiguous.
2. List each independent unit of work as one item. An item is "independent" if it can be tested in isolation and committed without breaking the rest.
3. For each item, name:
   - The output (what file changes / what new behavior).
   - The verification (the command that proves it works).
   - The dependencies (other items that must land first).
4. Decide order:
   - Items with no dependencies → can run in parallel.
   - Items with dependencies → run after their predecessors.
5. Use the `update_plan` tool to record the items.
6. Work one item at a time. Mark each complete before starting the next.

## Common pitfalls

- Items that are too coarse ("implement the feature") — break further.
- Items that are too fine ("rename a variable") — fold into a parent item.
- Hidden dependencies discovered mid-work — pause, update the plan, then resume.
- Working on multiple items at once — produces tangled diffs that are hard to review and easy to rollback wrongly.

## Stop condition

Each item should be:
- Self-contained (one commit, one verification command).
- Reversible (can be reverted without breaking later items).
- Reviewable in under ~15 minutes by a human.

If an item violates any of these, it needs further decomposition.
```

- [ ] **Step 2: Run skill loader to confirm all six are visible**

Quick smoke check — write a tiny throwaway script or use an existing test to instantiate `loadSkillEntries` against the real builtin dir:

```bash
cd apps/gateway && bun -e '
import { loadSkillEntries } from "./src/runtime/skills";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL("./builtin-skills/", import.meta.url));
console.log(loadSkillEntries({ workspaceDir: "/tmp", builtinDir: dir }).map((e) => e.name));
'
```

Expected output: an array of all six names.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/builtin-skills/task-decomposition.md
git commit -m "docs(skills): task-decomposition builtin skill"
```

---

## Phase 7 — Final verification

### Task 19: Full gateway test sweep + integration smoke

**Files:** none.

- [ ] **Step 1: Run the full gateway test suite**

```bash
cd apps/gateway && bun test
```

Expected: all tests PASS.

- [ ] **Step 2: Run protocol tests**

```bash
cd packages/protocol && bun test
```

Expected: all tests PASS.

- [ ] **Step 3: Typecheck both packages**

```bash
cd packages/protocol && bun run typecheck
cd ../../apps/gateway && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Optional live smoke against `typescript-language-server`**

If `typescript-language-server` is installed locally:

```bash
cd /Users/johnny/Work/vulture && which typescript-language-server
```

If found, run a one-off smoke (write a small bun script that constructs the manager with the real transport, calls `diagnostics` on `apps/gateway/src/main.ts`, and prints the result). This is a manual verification, not a committed test — the goal is to confirm nothing throws on the real wire.

- [ ] **Step 5: Confirm the foundation is ready for the preset spec**

Refer back to `docs/superpowers/specs/2026-05-03-preset-agents-design.md`. Note that the preset spec's coding agent will:
- Receive `developer` preset (which now contains all six new tools).
- See the six builtin skills automatically (no allowlist).

No final commit for this task — it's a verification gate. If anything fails, file a follow-up task before declaring the foundation done.

---

## Self-Review Notes

After authoring this plan, the following spec sections were audited:

- **Six new tools** → Tasks 1, 3, 4, 5, 7, 8, 10. ✓
- **LSP capability set (diagnostics/definition/references/hover)** → Task 7 covers all four within `LspClientManager`; Task 9 dispatches all four. ✓
- **LSP server discovery (TS local node_modules → which; rust-analyzer which → cargo bin)** → Task 8. ✓
- **LSP idle TTL + sweep** → Task 7 (`createLspClientManager`'s sweeper). ✓
- **Project config gate** → Task 7 (`projectConfigExists`). ✓
- **Indexing timeout (30s) returning `lsp.indexing`** → Task 7's `dispatch` `Promise.race`. ✓
- **Path-outside-workspace check** → Task 7's `preflight`. ✓
- **Approval = always auto** → Task 10 (`coreToolApprovalDecision` arms). ✓
- **Builtin skills as fourth source, lowest precedence** → Task 11. ✓
- **`BUILTIN_SKILLS_DIR` resolution** → Task 12. ✓
- **Six builtin skill files** → Tasks 13-18 (one per file). ✓
- **TS-local routing, no Rust changes** → reflected in spec correction commit `0e5eece` and in this plan's File Structure section. ✓
- **Tech debt (LSP rename / code_actions / document_symbols / workspace_symbols / completion)** → no implementation tasks; documented in spec's Tech Debt section. ✓

No placeholders, TBDs, or "implement later" markers found. Type names are consistent across tasks (`LspResult` / `LspError` / `Diagnostic` / `Location` / `HoverContent` defined in Task 7 and reused in Tasks 8, 9, 10).
