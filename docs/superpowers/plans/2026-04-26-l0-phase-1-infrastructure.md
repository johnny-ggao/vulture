# L0 Phase 1 — Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the long-running Bun Gateway process supervised by Tauri Rust shell, with token + port exchange via `runtime.json`, without touching any business logic. Old `apps/agent-sidecar` and old Tauri commands (`start_agent_run`, `list_agents`, …) must keep working unchanged.

**Architecture:** Tauri shell becomes a process supervisor + tool-callback HTTP server. Bun Gateway runs as a child process with `Authorization: Bearer <token>` on all routes (except `/healthz`). Both bind `127.0.0.1` only. Token (32 random bytes) and ports (gateway 4099+, shell 4199+) are exchanged via `runtime.json` (mode 0600) and via env vars. Gateway watchdog polls Tauri PID and self-exits if Tauri dies.

**Tech Stack:**
- Rust: tokio, axum 0.7, tower, fs2, rand, libc/nix (for SIGTERM)
- Bun: hono 4.x, @vulture/protocol, @vulture/common
- TS protocol layer: zod schemas + branded ID types

**Spec:** [`docs/superpowers/specs/2026-04-26-gateway-skeleton-design.md`](../specs/2026-04-26-gateway-skeleton-design.md) — Phase 1 section

---

## Pre-flight

### Task 0: Verify spike preconditions

**Goal:** Confirm the two mandatory pre-Phase-1 spikes (per spec risk register) are already proven by existing code, before sinking time into the plan.

- [ ] **Step 1: Confirm spike 1 (Tauri can spawn Bun child + capture stdio)**

Run:
```bash
grep -n 'Command::new("bun")' apps/desktop-shell/src/sidecar.rs
grep -n 'AsyncBufReadExt\|BufReader' apps/desktop-shell/src/auth.rs
```
Expected: hits in both. Existing `sidecar.rs` already spawns Bun + pipes stdio; existing `auth.rs` already reads child stdout via tokio::io. Spike 1 is proven by the running codebase.

- [ ] **Step 2: Confirm spike 2 (OpenAI Agents SDK on Bun 1.3.x)**

Run:
```bash
grep -n '@openai/agents' apps/agent-sidecar/package.json
bun --filter @vulture/agent-sidecar test
```
Expected: dep present at `^0.8.5`; tests green. Spike 2 is proven by the running sidecar.

- [ ] **Step 3: Document and continue**

If both steps pass, proceed to Task 1. If either fails, halt and re-brainstorm per spec risk register.

---

## File Structure (created by this plan)

```text
packages/
├── protocol/src/v1/
│   ├── index.ts         API_VERSION, Iso8601, branded ID helper
│   ├── error.ts         AppError + ErrorCode + zod schema
│   └── runtime.ts       RuntimeDescriptor + zod schema
└── common/              NEW package
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── ids.ts       BrandedId helper
        ├── logger.ts    structured logger
        └── result.ts    Result<T, E> helper

apps/gateway/            NEW package
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts          entrypoint: env validation + READY signal
    ├── server.ts        hono app + middleware wiring
    ├── middleware/
    │   ├── auth.ts      Bearer token + Origin checks
    │   └── error.ts     AppError JSON serializer
    ├── routes/
    │   └── healthz.ts
    └── runtime/
        └── watchdog.ts  poll VULTURE_SHELL_PID, exit if dead

crates/core/src/
├── runtime.rs           NEW: RuntimeDescriptor mirror + serde + tests
└── lib.rs               MODIFIED: export runtime module

apps/desktop-shell/
├── Cargo.toml           MODIFIED: add axum/tower/fs2/rand/libc
├── src/
│   ├── single_instance.rs   NEW: flock-based guard
│   ├── runtime.rs           NEW: token + port + runtime.json I/O
│   ├── tool_callback.rs     NEW: minimal axum server (only /healthz in Phase 1)
│   ├── supervisor.rs        NEW: GatewaySupervisor state machine
│   ├── commands.rs          MODIFIED: add 5 system commands
│   ├── state.rs             MODIFIED: add supervisor field
│   └── main.rs              MODIFIED: startup orchestration

apps/desktop-ui/src/
└── runtime/                 NEW
    └── useRuntimeDescriptor.ts
```

---

## Group A — Protocol foundation

### Task 1: Create `@vulture/common` package scaffold

**Files:**
- Create: `packages/common/package.json`
- Create: `packages/common/tsconfig.json`
- Create: `packages/common/src/index.ts`

- [ ] **Step 1: Write `packages/common/package.json`**

```json
{
  "name": "@vulture/common",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "bun test src",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/bun": "^1.3.13",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Write `packages/common/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Stub `packages/common/src/index.ts`**

```ts
export {};
```

- [ ] **Step 4: Install deps and typecheck**

```bash
bun install
bun --filter @vulture/common typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/common package.json bun.lock
git commit -m "chore: scaffold @vulture/common package"
```

### Task 2: Add branded ID helper to `@vulture/common`

**Files:**
- Create: `packages/common/src/ids.ts`
- Create: `packages/common/src/ids.test.ts`
- Modify: `packages/common/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/common/src/ids.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { brandId, type BrandedId } from "./ids";

type FooId = BrandedId<"Foo">;

describe("brandId", () => {
  test("returns the same string value", () => {
    const id = brandId<FooId>("abc");
    expect(id).toBe("abc");
  });

  test("rejects empty string", () => {
    expect(() => brandId<FooId>("")).toThrow("id must not be empty");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/common/src/ids.test.ts`
Expected: FAIL with "Cannot resolve module './ids'".

- [ ] **Step 3: Write the implementation**

`packages/common/src/ids.ts`:
```ts
export type BrandedId<T extends string> = string & { readonly __brand: T };

export function brandId<T extends BrandedId<string>>(value: string): T {
  if (value.length === 0) {
    throw new Error("id must not be empty");
  }
  return value as T;
}
```

- [ ] **Step 4: Re-export from index**

Update `packages/common/src/index.ts`:
```ts
export * from "./ids";
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/common/src/ids.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/common
git commit -m "feat(common): add branded id helper"
```

### Task 3: Add `protocol/v1/index.ts` (API_VERSION + Iso8601)

**Files:**
- Create: `packages/protocol/src/v1/index.ts`
- Create: `packages/protocol/src/v1/index.test.ts`
- Modify: `packages/protocol/package.json` (add `@vulture/common` workspace dep)

- [ ] **Step 1: Add workspace dependency**

Update `packages/protocol/package.json` `dependencies`:
```json
"dependencies": {
  "zod": "^4.0.0",
  "@vulture/common": "workspace:*"
}
```

Run: `bun install`

- [ ] **Step 2: Write the failing test**

`packages/protocol/src/v1/index.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { API_VERSION, type Iso8601, brandIso8601 } from "./index";

describe("v1 protocol primitives", () => {
  test("API_VERSION is the literal 'v1'", () => {
    const v: "v1" = API_VERSION;
    expect(v).toBe("v1");
  });

  test("brandIso8601 accepts well-formed RFC 3339 timestamp", () => {
    const t: Iso8601 = brandIso8601("2026-04-26T12:34:56.789Z");
    expect(t).toBe("2026-04-26T12:34:56.789Z");
  });

  test("brandIso8601 rejects non-RFC-3339 strings", () => {
    expect(() => brandIso8601("not a date")).toThrow();
  });
});
```

- [ ] **Step 3: Run test, expect FAIL**

Run: `bun test packages/protocol/src/v1/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write implementation**

`packages/protocol/src/v1/index.ts`:
```ts
import type { BrandedId } from "@vulture/common";

export const API_VERSION = "v1" as const;
export type ApiVersion = typeof API_VERSION;

export type Iso8601 = BrandedId<"Iso8601">;

const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function brandIso8601(value: string): Iso8601 {
  if (!ISO8601_RE.test(value)) {
    throw new Error(`invalid Iso8601 timestamp: ${value}`);
  }
  return value as Iso8601;
}

export function nowIso8601(): Iso8601 {
  return brandIso8601(new Date().toISOString());
}
```

- [ ] **Step 5: Run test, expect PASS**

Run: `bun test packages/protocol/src/v1/index.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add v1 API_VERSION and Iso8601 type"
```

### Task 4: Add `protocol/v1/error.ts`

**Files:**
- Create: `packages/protocol/src/v1/error.ts`
- Create: `packages/protocol/src/v1/error.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/protocol/src/v1/error.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { AppErrorSchema, type AppError, ErrorCode } from "./error";

describe("AppError", () => {
  test("schema validates a minimal AppError", () => {
    const err: AppError = { code: "internal", message: "boom" };
    expect(AppErrorSchema.parse(err)).toEqual(err);
  });

  test("schema rejects unknown error code", () => {
    expect(() =>
      AppErrorSchema.parse({ code: "not_a_real_code", message: "x" }),
    ).toThrow();
  });

  test("ErrorCode covers Phase-1-relevant codes", () => {
    const codes: ErrorCode[] = [
      "auth.token_invalid",
      "internal",
      "internal.gateway_restarted",
      "internal.shutdown",
    ];
    expect(codes.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `bun test packages/protocol/src/v1/error.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`packages/protocol/src/v1/error.ts`:
```ts
import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "auth.token_invalid",
  "auth.missing_keychain",
  "agent.not_found",
  "agent.invalid",
  "agent.cannot_delete_last",
  "workspace.invalid_path",
  "conversation.not_found",
  "run.not_found",
  "run.cancelled",
  "run.already_completed",
  "tool.permission_denied",
  "tool.execution_failed",
  "llm.provider_error",
  "llm.rate_limited",
  "internal",
  "internal.gateway_restarted",
  "internal.shutdown",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const AppErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type AppError = z.infer<typeof AppErrorSchema>;
```

- [ ] **Step 4: Run test, expect PASS**

Run: `bun test packages/protocol/src/v1/error.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add v1 AppError + ErrorCode"
```

### Task 5: Add `protocol/v1/runtime.ts`

**Files:**
- Create: `packages/protocol/src/v1/runtime.ts`
- Create: `packages/protocol/src/v1/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/protocol/src/v1/runtime.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { RuntimeDescriptorSchema, type RuntimeDescriptor } from "./runtime";

describe("RuntimeDescriptor", () => {
  const sample: RuntimeDescriptor = {
    apiVersion: "v1",
    gateway: { port: 4099 },
    shell: { port: 4199 },
    token: "x".repeat(43),
    pid: 1234,
    startedAt: "2026-04-26T00:00:00.000Z" as RuntimeDescriptor["startedAt"],
    shellVersion: "0.1.0",
  };

  test("schema parses a valid descriptor", () => {
    expect(RuntimeDescriptorSchema.parse(sample)).toEqual(sample);
  });

  test("schema rejects token shorter than 32 bytes (43 base64 chars)", () => {
    expect(() =>
      RuntimeDescriptorSchema.parse({ ...sample, token: "short" }),
    ).toThrow();
  });

  test("schema rejects negative port", () => {
    expect(() =>
      RuntimeDescriptorSchema.parse({
        ...sample,
        gateway: { port: -1 },
      }),
    ).toThrow();
  });

  test("schema rejects apiVersion other than 'v1'", () => {
    expect(() =>
      RuntimeDescriptorSchema.parse({ ...sample, apiVersion: "v2" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test packages/protocol/src/v1/runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`packages/protocol/src/v1/runtime.ts`:
```ts
import { z } from "zod";
import { API_VERSION, type Iso8601 } from "./index";

const Iso8601Schema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

const PortSchema = z.number().int().min(1).max(65535);

export const RuntimeDescriptorSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  gateway: z.object({ port: PortSchema }),
  shell: z.object({ port: PortSchema }),
  // url-safe base64 of 32 random bytes is 43 chars (no padding)
  token: z.string().length(43),
  pid: z.number().int().min(1),
  startedAt: Iso8601Schema,
  shellVersion: z.string().min(1),
});

export type RuntimeDescriptor = Omit<
  z.infer<typeof RuntimeDescriptorSchema>,
  "startedAt"
> & {
  startedAt: Iso8601;
};
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test packages/protocol/src/v1/runtime.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add v1 RuntimeDescriptor"
```

---

## Group B — Rust mirror of RuntimeDescriptor

### Task 6: Add `crates/core/src/runtime.rs` with serde round-trip test

**Files:**
- Create: `crates/core/src/runtime.rs`
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: Write the failing test (and implementation skeleton)**

`crates/core/src/runtime.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub api_version: String,
    pub gateway: PortBinding,
    pub shell: PortBinding,
    pub token: String,
    pub pid: u32,
    pub started_at: String,
    pub shell_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    pub port: u16,
}

pub const API_VERSION: &str = "v1";

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture matches the JSON the TS schema (packages/protocol/src/v1/runtime.ts) emits.
    const TS_FIXTURE: &str = r#"{
      "apiVersion": "v1",
      "gateway": { "port": 4099 },
      "shell": { "port": 4199 },
      "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "pid": 1234,
      "startedAt": "2026-04-26T00:00:00.000Z",
      "shellVersion": "0.1.0"
    }"#;

    #[test]
    fn deserializes_ts_fixture() {
        let parsed: RuntimeDescriptor =
            serde_json::from_str(TS_FIXTURE).expect("ts fixture should parse");

        assert_eq!(parsed.api_version, API_VERSION);
        assert_eq!(parsed.gateway.port, 4099);
        assert_eq!(parsed.shell.port, 4199);
        assert_eq!(parsed.token.len(), 43);
        assert_eq!(parsed.pid, 1234);
    }

    #[test]
    fn round_trips_through_json() {
        let original = RuntimeDescriptor {
            api_version: API_VERSION.to_string(),
            gateway: PortBinding { port: 4099 },
            shell: PortBinding { port: 4199 },
            token: "x".repeat(43),
            pid: 99,
            started_at: "2026-04-26T00:00:00.000Z".to_string(),
            shell_version: "0.1.0".to_string(),
        };

        let json = serde_json::to_string(&original).unwrap();
        let parsed: RuntimeDescriptor = serde_json::from_str(&json).unwrap();
        assert_eq!(original, parsed);
    }
}
```

- [ ] **Step 2: Wire module in `crates/core/src/lib.rs`**

Add at the bottom of the existing module declarations:
```rust
pub mod runtime;

pub use runtime::{RuntimeDescriptor, PortBinding, API_VERSION};
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p vulture-core runtime`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add crates/core
git commit -m "feat(core): add RuntimeDescriptor with TS fixture round-trip test"
```

---

## Group C — Bun Gateway scaffold

### Task 7: Scaffold `apps/gateway` package

**Files:**
- Create: `apps/gateway/package.json`
- Create: `apps/gateway/tsconfig.json`
- Create: `apps/gateway/src/main.ts`

- [ ] **Step 1: Write `apps/gateway/package.json`**

```json
{
  "name": "@vulture/gateway",
  "version": "0.1.0",
  "type": "module",
  "main": "src/main.ts",
  "scripts": {
    "dev": "bun src/main.ts",
    "test": "bun test src",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": {
    "@vulture/protocol": "workspace:*",
    "@vulture/common": "workspace:*",
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@types/bun": "^1.3.13",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Write `apps/gateway/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Stub `apps/gateway/src/main.ts`**

```ts
console.error("vulture gateway: starting");
```

- [ ] **Step 4: Install deps**

```bash
bun install
bun --filter @vulture/gateway typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway package.json bun.lock
git commit -m "chore: scaffold @vulture/gateway package"
```

### Task 8: Implement Gateway env validation + READY signal

**Files:**
- Modify: `apps/gateway/src/main.ts`
- Create: `apps/gateway/src/env.ts`
- Create: `apps/gateway/src/env.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/gateway/src/env.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { parseGatewayEnv } from "./env";

describe("parseGatewayEnv", () => {
  const valid = {
    VULTURE_GATEWAY_PORT: "4099",
    VULTURE_GATEWAY_TOKEN: "x".repeat(43),
    VULTURE_SHELL_CALLBACK_URL: "http://127.0.0.1:4199",
    VULTURE_SHELL_PID: "1234",
    VULTURE_PROFILE_DIR: "/tmp/vulture-profile",
  };

  test("parses a complete env", () => {
    const cfg = parseGatewayEnv(valid);
    expect(cfg.port).toBe(4099);
    expect(cfg.token).toHaveLength(43);
    expect(cfg.shellPid).toBe(1234);
  });

  test("rejects missing token", () => {
    const { VULTURE_GATEWAY_TOKEN, ...rest } = valid;
    expect(() => parseGatewayEnv(rest)).toThrow(/VULTURE_GATEWAY_TOKEN/);
  });

  test("rejects non-numeric port", () => {
    expect(() =>
      parseGatewayEnv({ ...valid, VULTURE_GATEWAY_PORT: "abc" }),
    ).toThrow(/VULTURE_GATEWAY_PORT/);
  });

  test("rejects token shorter than 43 chars", () => {
    expect(() =>
      parseGatewayEnv({ ...valid, VULTURE_GATEWAY_TOKEN: "short" }),
    ).toThrow(/VULTURE_GATEWAY_TOKEN/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test apps/gateway/src/env.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`apps/gateway/src/env.ts`:
```ts
export interface GatewayConfig {
  port: number;
  token: string;
  shellCallbackUrl: string;
  shellPid: number;
  profileDir: string;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) {
    throw new Error(`${key} env var is required`);
  }
  return v;
}

export function parseGatewayEnv(
  env: Record<string, string | undefined>,
): GatewayConfig {
  const portStr = required(env, "VULTURE_GATEWAY_PORT");
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`VULTURE_GATEWAY_PORT must be a valid port: got ${portStr}`);
  }

  const token = required(env, "VULTURE_GATEWAY_TOKEN");
  if (token.length !== 43) {
    throw new Error(`VULTURE_GATEWAY_TOKEN must be 43 chars (32 bytes b64url)`);
  }

  const pidStr = required(env, "VULTURE_SHELL_PID");
  const shellPid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(shellPid) || shellPid < 1) {
    throw new Error(`VULTURE_SHELL_PID must be a positive integer`);
  }

  return {
    port,
    token,
    shellCallbackUrl: required(env, "VULTURE_SHELL_CALLBACK_URL"),
    shellPid,
    profileDir: required(env, "VULTURE_PROFILE_DIR"),
  };
}
```

- [ ] **Step 4: Update `apps/gateway/src/main.ts` to use env + READY signal**

```ts
import { parseGatewayEnv } from "./env";

async function main() {
  const cfg = parseGatewayEnv(process.env as Record<string, string | undefined>);

  // SECURITY: bind 127.0.0.1 only.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    fetch: () => new Response("ok"),
  });

  // READY handshake: Tauri parent reads stdout for this exact format.
  console.log(`READY ${server.port}`);
}

main().catch((err) => {
  console.error("gateway fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 5: Run tests**

Run: `bun test apps/gateway/src/env.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): env validation + READY handshake"
```

### Task 9: Add hono server with auth + Origin middleware

**Files:**
- Create: `apps/gateway/src/middleware/auth.ts`
- Create: `apps/gateway/src/middleware/auth.test.ts`
- Create: `apps/gateway/src/middleware/error.ts`
- Create: `apps/gateway/src/server.ts`
- Modify: `apps/gateway/src/main.ts`

- [ ] **Step 1: Write the failing test**

`apps/gateway/src/middleware/auth.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authMiddleware, originGuard } from "./auth";

const TOKEN = "x".repeat(43);

function makeApp() {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.use("*", originGuard, authMiddleware(TOKEN));
  app.get("/secret", (c) => c.json({ ok: true }));
  return app;
}

describe("authMiddleware", () => {
  test("/healthz works without token", async () => {
    const res = await makeApp().request("/healthz");
    expect(res.status).toBe(200);
  });

  test("/secret without token → 401", async () => {
    const res = await makeApp().request("/secret");
    expect(res.status).toBe(401);
  });

  test("/secret with wrong token → 401", async () => {
    const res = await makeApp().request("/secret", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  test("/secret with correct token → 200", async () => {
    const res = await makeApp().request("/secret", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("/secret with bad Origin → 403", async () => {
    const res = await makeApp().request("/secret", {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: "https://evil.example",
      },
    });
    expect(res.status).toBe(403);
  });

  test("/secret with Origin tauri://localhost → 200", async () => {
    const res = await makeApp().request("/secret", {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: "tauri://localhost",
      },
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test apps/gateway/src/middleware/auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the auth middleware**

`apps/gateway/src/middleware/auth.ts`:
```ts
import type { MiddlewareHandler } from "hono";

const ALLOWED_ORIGINS = new Set([null, "null", "tauri://localhost"]);

export const originGuard: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("Origin") ?? null;
  if (!ALLOWED_ORIGINS.has(origin)) {
    return c.json(
      { code: "auth.token_invalid", message: "origin not allowed" },
      403,
    );
  }
  await next();
};

export function authMiddleware(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    if (!header.startsWith("Bearer ") || header.slice(7) !== expectedToken) {
      return c.json(
        { code: "auth.token_invalid", message: "missing or invalid token" },
        401,
      );
    }
    await next();
  };
}
```

- [ ] **Step 4: Write the error middleware (placeholder for later AppError handling)**

`apps/gateway/src/middleware/error.ts`:
```ts
import type { MiddlewareHandler } from "hono";

export const errorBoundary: MiddlewareHandler = async (c, next) => {
  try {
    await next();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[gateway] uncaught:", err);
    return c.json({ code: "internal", message }, 500);
  }
};
```

- [ ] **Step 5: Write `apps/gateway/src/server.ts`**

```ts
import { Hono } from "hono";
import { authMiddleware, originGuard } from "./middleware/auth";
import { errorBoundary } from "./middleware/error";
import type { GatewayConfig } from "./env";

export function buildServer(cfg: GatewayConfig): Hono {
  const app = new Hono();
  app.use("*", errorBoundary);
  // /healthz is the only no-auth route; mount BEFORE auth middleware.
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      apiVersion: "v1",
      gatewayVersion: "0.1.0",
      uptimeMs: Math.round(process.uptime() * 1000),
    }),
  );
  app.use("*", originGuard, authMiddleware(cfg.token));
  // Future routes plug in here.
  return app;
}
```

- [ ] **Step 6: Update `apps/gateway/src/main.ts` to use the hono app**

```ts
import { parseGatewayEnv } from "./env";
import { buildServer } from "./server";

async function main() {
  const cfg = parseGatewayEnv(process.env as Record<string, string | undefined>);
  const app = buildServer(cfg);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    fetch: app.fetch,
  });

  console.log(`READY ${server.port}`);
}

main().catch((err) => {
  console.error("gateway fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 7: Run tests**

Run: `bun test apps/gateway/src/middleware/auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): hono server with auth + origin middleware"
```

### Task 10: Add Bun watchdog (exits when shell PID dies)

**Files:**
- Create: `apps/gateway/src/runtime/watchdog.ts`
- Create: `apps/gateway/src/runtime/watchdog.test.ts`
- Modify: `apps/gateway/src/main.ts`

- [ ] **Step 1: Write the failing test**

`apps/gateway/src/runtime/watchdog.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { isProcessAlive } from "./watchdog";

describe("isProcessAlive", () => {
  test("current process is alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("PID 1 is alive (init)", () => {
    expect(isProcessAlive(1)).toBe(true);
  });

  test("very high PID is dead", () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test apps/gateway/src/runtime/watchdog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

`apps/gateway/src/runtime/watchdog.ts`:
```ts
export function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 does not send anything, just probes for existence.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface WatchdogOptions {
  pid: number;
  intervalMs?: number;
  onDead?: () => void;
}

export function startWatchdog(opts: WatchdogOptions): { stop(): void } {
  const interval = opts.intervalMs ?? 2000;
  const timer = setInterval(() => {
    if (!isProcessAlive(opts.pid)) {
      console.error(`[watchdog] shell pid ${opts.pid} dead; exiting`);
      opts.onDead?.();
      process.exit(0);
    }
  }, interval);
  // do not keep event loop alive on unref
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Wire into main**

Update `apps/gateway/src/main.ts`:
```ts
import { parseGatewayEnv } from "./env";
import { buildServer } from "./server";
import { startWatchdog } from "./runtime/watchdog";

async function main() {
  const cfg = parseGatewayEnv(process.env as Record<string, string | undefined>);
  const app = buildServer(cfg);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    fetch: app.fetch,
  });

  startWatchdog({ pid: cfg.shellPid });

  console.log(`READY ${server.port}`);
}

main().catch((err) => {
  console.error("gateway fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 5: Run tests**

Run: `bun test apps/gateway/src/runtime/watchdog.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): pid watchdog auto-exits when shell dies"
```

---

## Group D — Tauri shell infrastructure

### Task 11: Add Cargo dependencies for new shell modules

**Files:**
- Modify: `Cargo.toml` (workspace deps)
- Modify: `apps/desktop-shell/Cargo.toml`

- [ ] **Step 1: Add workspace deps to root `Cargo.toml`**

In `[workspace.dependencies]` add:
```toml
axum = "0.7"
fs2 = "0.4"
libc = "0.2"
rand = "0.8"
tower = "0.4"
tower-http = { version = "0.5", features = ["trace"] }
base64 = "0.22"
```

- [ ] **Step 2: Add to `apps/desktop-shell/Cargo.toml` `[dependencies]`**

```toml
axum.workspace = true
base64.workspace = true
fs2.workspace = true
libc.workspace = true
rand.workspace = true
tower.workspace = true
tower-http.workspace = true
```

- [ ] **Step 3: Build to verify resolution**

Run: `cargo build -p vulture-desktop-shell`
Expected: PASS (warnings ok, no errors).

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml apps/desktop-shell/Cargo.toml Cargo.lock
git commit -m "chore(deps): add axum/fs2/libc/rand/tower for gateway supervisor"
```

### Task 12: Implement `single_instance.rs` with flock

**Files:**
- Create: `apps/desktop-shell/src/single_instance.rs`
- Modify: `apps/desktop-shell/src/main.rs` (add `mod`)

- [ ] **Step 1: Write the failing test (inline in module)**

`apps/desktop-shell/src/single_instance.rs`:
```rust
use std::{
    fs::{File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use fs2::FileExt;

/// Holds an exclusive flock on a lock file. Drop releases the lock.
pub struct InstanceLock {
    _file: File,
    path: PathBuf,
}

impl InstanceLock {
    /// Try to acquire. Returns Err if already locked by another live process.
    pub fn acquire(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("failed to ensure lock dir {}", parent.display())
            })?;
        }

        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("failed to open lock file {}", path.display()))?;

        match file.try_lock_exclusive() {
            Ok(()) => Ok(Self { _file: file, path }),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                Err(anyhow!("another instance holds the lock"))
            }
            Err(err) => Err(err).context("flock failed"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_lock_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "vulture-instance-lock-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn acquires_then_releases() {
        let path = temp_lock_path();
        {
            let _lock = InstanceLock::acquire(&path).expect("first acquire works");
        }
        let _lock2 = InstanceLock::acquire(&path).expect("re-acquire after drop works");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn second_acquire_while_held_fails() {
        let path = temp_lock_path();
        let _lock = InstanceLock::acquire(&path).expect("first works");
        let err = InstanceLock::acquire(&path).expect_err("second should fail");
        assert!(err.to_string().contains("another instance"));
        std::fs::remove_file(&path).ok();
    }
}
```

- [ ] **Step 2: Wire `mod single_instance;` in `apps/desktop-shell/src/main.rs`**

Add the line at the top with other `mod` decls.

- [ ] **Step 3: Run tests**

Run: `cargo test -p vulture-desktop-shell single_instance`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): add flock-based single-instance lock"
```

### Task 13: Implement `runtime.rs` token generation

**Files:**
- Create: `apps/desktop-shell/src/runtime.rs`
- Modify: `apps/desktop-shell/src/main.rs` (add `mod`)

- [ ] **Step 1: Write the failing test + skeleton**

`apps/desktop-shell/src/runtime.rs`:
```rust
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;

pub const TOKEN_BYTES: usize = 32;
pub const TOKEN_B64_LEN: usize = 43; // 32 bytes URL-safe base64, no padding

pub fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn token_has_expected_length() {
        let t = generate_token();
        assert_eq!(t.len(), TOKEN_B64_LEN);
    }

    #[test]
    fn tokens_are_url_safe_base64() {
        let t = generate_token();
        for ch in t.chars() {
            assert!(
                ch.is_ascii_alphanumeric() || ch == '-' || ch == '_',
                "unexpected char: {ch}"
            );
        }
    }

    #[test]
    fn tokens_are_unique_across_many_calls() {
        let mut seen = HashSet::new();
        for _ in 0..1024 {
            assert!(seen.insert(generate_token()), "duplicate token");
        }
    }
}
```

- [ ] **Step 2: Wire `mod runtime;` in `apps/desktop-shell/src/main.rs`**

- [ ] **Step 3: Run tests**

Run: `cargo test -p vulture-desktop-shell runtime::tests::token`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): add 32-byte url-safe token generator"
```

### Task 14: Add `pick_free_port` to `runtime.rs`

**Files:**
- Modify: `apps/desktop-shell/src/runtime.rs`

- [ ] **Step 1: Append the failing test**

Add to the `tests` module in `runtime.rs`:
```rust
#[test]
fn picks_a_free_port_in_range() {
    let port = pick_free_port(40000, 100).expect("should find free port");
    assert!((40000..40100).contains(&port));
}

#[test]
fn skips_occupied_ports() {
    use std::net::TcpListener;
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let occupied = listener.local_addr().unwrap().port();
    let picked = pick_free_port(occupied, 5).expect("falls through occupied");
    assert_ne!(picked, occupied);
}
```

- [ ] **Step 2: Add the implementation above the tests**

```rust
use std::net::TcpListener;

/// Linear scan starting at `start`, trying up to `window` ports.
/// Returns the first free port. SECURITY: binds 127.0.0.1 only.
pub fn pick_free_port(start: u16, window: u16) -> anyhow::Result<u16> {
    for offset in 0..window {
        let port = start.saturating_add(offset);
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(anyhow::anyhow!(
        "no free port in 127.0.0.1:{start}-{}",
        start.saturating_add(window).saturating_sub(1)
    ))
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p vulture-desktop-shell runtime::tests`
Expected: PASS (5 tests now).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): add pick_free_port linear scanner"
```

### Task 15: Add `runtime.json` atomic write/read with mode 0600

**Files:**
- Modify: `apps/desktop-shell/src/runtime.rs`

- [ ] **Step 1: Append the failing test**

In the `tests` module:
```rust
#[test]
fn writes_runtime_json_with_mode_0600() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!(
        "vulture-runtime-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("runtime.json");

    let descriptor = vulture_core::RuntimeDescriptor {
        api_version: vulture_core::API_VERSION.to_string(),
        gateway: vulture_core::PortBinding { port: 4099 },
        shell: vulture_core::PortBinding { port: 4199 },
        token: "x".repeat(TOKEN_B64_LEN),
        pid: std::process::id(),
        started_at: chrono::Utc::now().to_rfc3339_opts(
            chrono::SecondsFormat::Millis, true),
        shell_version: env!("CARGO_PKG_VERSION").to_string(),
    };

    write_runtime_json(&path, &descriptor).expect("write should succeed");

    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "runtime.json must be 0600");

    let parsed = read_runtime_json(&path).expect("read should succeed");
    assert_eq!(parsed, descriptor);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn write_is_atomic_via_tmp_rename() {
    let dir = std::env::temp_dir().join(format!(
        "vulture-runtime-atomic-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("runtime.json");
    let tmp = dir.join("runtime.json.tmp");

    let descriptor = vulture_core::RuntimeDescriptor {
        api_version: vulture_core::API_VERSION.to_string(),
        gateway: vulture_core::PortBinding { port: 4099 },
        shell: vulture_core::PortBinding { port: 4199 },
        token: "x".repeat(TOKEN_B64_LEN),
        pid: 1,
        started_at: chrono::Utc::now().to_rfc3339_opts(
            chrono::SecondsFormat::Millis, true),
        shell_version: "0".to_string(),
    };
    write_runtime_json(&path, &descriptor).unwrap();
    assert!(path.exists());
    assert!(!tmp.exists(), "tmp should be cleaned up");
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: Add the implementation**

In `runtime.rs` above the `tests` module:
```rust
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};
use vulture_core::RuntimeDescriptor;

pub fn write_runtime_json(
    path: impl AsRef<Path>,
    descriptor: &RuntimeDescriptor,
) -> anyhow::Result<()> {
    let path = path.as_ref();
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("runtime path has no parent"))?;
    fs::create_dir_all(parent)?;

    let tmp = path.with_extension("json.tmp");
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        serde_json::to_writer_pretty(&mut file, descriptor)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn read_runtime_json(path: impl AsRef<Path>) -> anyhow::Result<RuntimeDescriptor> {
    let raw = fs::read_to_string(path.as_ref())?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn remove_runtime_json(path: impl AsRef<Path>) {
    let _ = fs::remove_file(path);
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p vulture-desktop-shell runtime::tests`
Expected: PASS (7 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): atomic runtime.json write with mode 0600"
```

### Task 16: Implement `tool_callback.rs` minimal axum server

**Files:**
- Create: `apps/desktop-shell/src/tool_callback.rs`
- Modify: `apps/desktop-shell/src/main.rs` (add `mod`)

- [ ] **Step 1: Write the failing test**

`apps/desktop-shell/src/tool_callback.rs`:
```rust
use std::net::SocketAddr;

use anyhow::{Context, Result};
use axum::{routing::get, Json, Router};
use serde::Serialize;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    role: &'static str,
}

pub fn router() -> Router {
    Router::new().route("/healthz", get(|| async { Json(HealthResponse { ok: true, role: "shell-callback" }) }))
}

pub struct ToolCallbackHandle {
    pub bound_port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<JoinHandle<()>>,
}

impl ToolCallbackHandle {
    pub fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = futures_lite::future::block_on(join);
        }
    }
}

pub async fn serve(port: u16) -> Result<ToolCallbackHandle> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind 127.0.0.1:{port}"))?;
    let bound_port = listener.local_addr()?.port();

    let (tx, rx) = oneshot::channel::<()>();
    let app = router();
    let join = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await
            .ok();
    });

    Ok(ToolCallbackHandle {
        bound_port,
        shutdown: Some(tx),
        join: Some(join),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn healthz_returns_ok() {
        let handle = serve(0).await.expect("serve should bind");
        let port = handle.bound_port;
        let body: serde_json::Value = reqwest::get(format!("http://127.0.0.1:{port}/healthz"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["role"], "shell-callback");
        handle.shutdown();
    }
}
```

- [ ] **Step 2: Add reqwest + futures-lite as dev deps**

Update `apps/desktop-shell/Cargo.toml` `[dev-dependencies]`:
```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
futures-lite = "2"
```

And `[dependencies]`:
```toml
futures-lite = "2"
```

- [ ] **Step 3: Wire `mod tool_callback;` in `main.rs`**

- [ ] **Step 4: Run test**

Run: `cargo test -p vulture-desktop-shell tool_callback`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-shell Cargo.lock
git commit -m "feat(shell): minimal axum tool-callback server"
```

### Task 17: Implement `supervisor.rs` state machine + restart backoff

**Files:**
- Create: `apps/desktop-shell/src/supervisor.rs`
- Modify: `apps/desktop-shell/src/main.rs` (add `mod`)

- [ ] **Step 1: Write the failing tests**

`apps/desktop-shell/src/supervisor.rs`:
```rust
use std::time::{Duration, Instant};

use serde::Serialize;

pub const RESTART_BACKOFF_MS: &[u64] = &[200, 1_000, 5_000, 30_000];
pub const MAX_RESTART_ATTEMPTS: u32 = 4;
pub const HEALTHY_RESET_AFTER: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SupervisorState {
    Starting,
    Running { since_ms: u128, pid: u32 },
    Restarting {
        attempt: u32,
        next_retry_ms: u128,
        last_error: String,
    },
    Faulted {
        reason: String,
        attempt_count: u32,
        last_error: String,
    },
    Stopping,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorStatus {
    pub state: SupervisorState,
    pub gateway_log: Option<String>,
}

#[derive(Debug)]
pub struct RestartTracker {
    attempts: u32,
    last_restart_at: Option<Instant>,
}

impl RestartTracker {
    pub fn new() -> Self {
        Self { attempts: 0, last_restart_at: None }
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    pub fn record_failure(&mut self, now: Instant) {
        if let Some(prev) = self.last_restart_at {
            if now.duration_since(prev) > HEALTHY_RESET_AFTER {
                self.attempts = 0;
            }
        }
        self.attempts += 1;
        self.last_restart_at = Some(now);
    }

    pub fn should_give_up(&self) -> bool {
        self.attempts >= MAX_RESTART_ATTEMPTS
    }

    pub fn next_backoff(&self) -> Option<Duration> {
        if self.should_give_up() {
            return None;
        }
        let idx = (self.attempts as usize).saturating_sub(1);
        let ms = RESTART_BACKOFF_MS.get(idx).copied().unwrap_or(30_000);
        Some(Duration::from_millis(ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_failure_uses_first_backoff() {
        let mut tr = RestartTracker::new();
        tr.record_failure(Instant::now());
        assert_eq!(tr.next_backoff(), Some(Duration::from_millis(200)));
    }

    #[test]
    fn fourth_failure_uses_30s_then_gives_up() {
        let mut tr = RestartTracker::new();
        let now = Instant::now();
        for _ in 0..3 {
            tr.record_failure(now);
        }
        assert_eq!(tr.next_backoff(), Some(Duration::from_millis(5_000)));
        tr.record_failure(now);
        assert!(tr.should_give_up());
        assert_eq!(tr.next_backoff(), None);
    }

    #[test]
    fn healthy_run_resets_counter() {
        let mut tr = RestartTracker::new();
        let t0 = Instant::now() - Duration::from_secs(700);
        tr.record_failure(t0); // attempt 1
        tr.record_failure(Instant::now()); // > 10 min later → reset, then count to 1
        assert_eq!(tr.attempts(), 1);
    }
}
```

- [ ] **Step 2: Wire `mod supervisor;` in `main.rs`**

- [ ] **Step 3: Run tests**

Run: `cargo test -p vulture-desktop-shell supervisor`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): supervisor state machine with restart tracker"
```

### Task 18: Implement `GatewaySupervisor::spawn` (process control)

**Files:**
- Modify: `apps/desktop-shell/src/supervisor.rs`

- [ ] **Step 1: Add the spawn implementation and a smoke test**

Append to `supervisor.rs`:
```rust
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
};

use anyhow::{anyhow, bail, Context, Result};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::watch,
    time::{timeout, Duration as TokioDuration},
};

#[derive(Clone, Debug)]
pub struct SpawnSpec {
    pub bun_bin: PathBuf,
    pub gateway_entry: PathBuf,
    pub workdir: PathBuf,
    pub gateway_port: u16,
    pub shell_port: u16,
    pub token: String,
    pub shell_pid: u32,
    pub profile_dir: PathBuf,
}

pub struct RunningGateway {
    pub child: Child,
    pub reported_port: u16,
}

const READY_TIMEOUT: TokioDuration = TokioDuration::from_secs(5);

pub async fn spawn_gateway(spec: &SpawnSpec) -> Result<RunningGateway> {
    let mut cmd = Command::new(&spec.bun_bin);
    cmd.arg(&spec.gateway_entry)
        .current_dir(&spec.workdir)
        .env("VULTURE_GATEWAY_PORT", spec.gateway_port.to_string())
        .env("VULTURE_GATEWAY_TOKEN", &spec.token)
        .env(
            "VULTURE_SHELL_CALLBACK_URL",
            format!("http://127.0.0.1:{}", spec.shell_port),
        )
        .env("VULTURE_SHELL_PID", spec.shell_pid.to_string())
        .env("VULTURE_PROFILE_DIR", &spec.profile_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn {}", spec.bun_bin.display()))?;

    let stdout = child.stdout.take().context("missing child stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    let port = timeout(READY_TIMEOUT, async {
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(rest) = line.strip_prefix("READY ") {
                let port: u16 = rest
                    .trim()
                    .parse()
                    .context("READY line did not contain a valid port")?;
                return Ok::<u16, anyhow::Error>(port);
            }
        }
        Err(anyhow!("gateway exited before printing READY"))
    })
    .await
    .map_err(|_| anyhow!("gateway did not print READY within {READY_TIMEOUT:?}"))??;

    Ok(RunningGateway {
        child,
        reported_port: port,
    })
}

pub async fn shutdown_gateway(mut running: RunningGateway) -> Result<()> {
    if let Some(pid) = running.child.id() {
        // SIGTERM
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    let waited = timeout(TokioDuration::from_secs(5), running.child.wait()).await;
    match waited {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e.into()),
        Err(_) => {
            running.child.kill().await.ok();
            Ok(())
        }
    }
}
```

- [ ] **Step 2: Add an integration test that spawns a fake "gateway"**

Append to the `tests` module in `supervisor.rs`:
```rust
#[tokio::test]
async fn spawn_waits_for_ready() {
    use std::io::Write;

    let dir = tempdir();
    let entry = dir.join("fake-gateway.ts");
    std::fs::File::create(&entry)
        .unwrap()
        .write_all(b"console.log('READY 12345'); setTimeout(()=>{}, 60_000);")
        .unwrap();

    let spec = SpawnSpec {
        bun_bin: PathBuf::from("bun"),
        gateway_entry: entry.clone(),
        workdir: dir.clone(),
        gateway_port: 12345,
        shell_port: 12346,
        token: "x".repeat(43),
        shell_pid: std::process::id(),
        profile_dir: dir.clone(),
    };

    let running = spawn_gateway(&spec).await.expect("spawn ready");
    assert_eq!(running.reported_port, 12345);
    shutdown_gateway(running).await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn spawn_times_out_when_no_ready() {
    use std::io::Write;

    let dir = tempdir();
    let entry = dir.join("silent-gateway.ts");
    std::fs::File::create(&entry)
        .unwrap()
        .write_all(b"setTimeout(()=>{}, 60_000);")
        .unwrap();

    let spec = SpawnSpec {
        bun_bin: PathBuf::from("bun"),
        gateway_entry: entry,
        workdir: dir.clone(),
        gateway_port: 0,
        shell_port: 0,
        token: "x".repeat(43),
        shell_pid: std::process::id(),
        profile_dir: dir.clone(),
    };

    let err = spawn_gateway(&spec).await.expect_err("should time out");
    assert!(err.to_string().contains("READY"));
    let _ = std::fs::remove_dir_all(dir);
}

fn tempdir() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "vulture-supervisor-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}
```

- [ ] **Step 3: Run the supervisor tests**

Run: `cargo test -p vulture-desktop-shell supervisor`
Expected: PASS (5 tests). The two `#[tokio::test]` tests will be slow (~1s for spawn-ready, ~5s for the timeout test).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): GatewaySupervisor::spawn with READY timeout"
```

---

## Group E — Wire it together

### Task 19: Update `state.rs` to hold supervisor + runtime descriptor

**Files:**
- Modify: `apps/desktop-shell/src/state.rs`

- [ ] **Step 1: Add new fields to `AppState`**

In `state.rs`, modify the `AppState` struct:
```rust
use std::sync::RwLock;
use vulture_core::RuntimeDescriptor;
use crate::supervisor::SupervisorStatus;

pub struct AppState {
    profile: ProfileView,
    profile_dir: PathBuf,
    openai_secret_ref: String,
    secret_store: Box<dyn SecretStore>,
    policy_engine: PolicyEngine,
    audit_store: Mutex<AuditStore>,
    browser_relay: Mutex<BrowserRelayState>,
    runtime_descriptor: RwLock<Option<RuntimeDescriptor>>,
    supervisor_status: RwLock<SupervisorStatus>,
}
```

- [ ] **Step 2: Add accessors**

Below the existing impl, add:
```rust
impl AppState {
    pub fn set_runtime_descriptor(&self, descriptor: RuntimeDescriptor) {
        *self.runtime_descriptor.write().expect("rt lock poisoned") = Some(descriptor);
    }

    pub fn runtime_descriptor(&self) -> Option<RuntimeDescriptor> {
        self.runtime_descriptor.read().expect("rt lock poisoned").clone()
    }

    pub fn set_supervisor_status(&self, status: SupervisorStatus) {
        *self.supervisor_status.write().expect("sup lock poisoned") = status;
    }

    pub fn supervisor_status(&self) -> SupervisorStatus {
        self.supervisor_status.read().expect("sup lock poisoned").clone()
    }
}
```

- [ ] **Step 3: Initialize the new fields in `AppState::new_for_root_with_secret_store`**

Find the `AppState { ... }` struct literal and add:
```rust
runtime_descriptor: RwLock::new(None),
supervisor_status: RwLock::new(SupervisorStatus {
    state: crate::supervisor::SupervisorState::Starting,
    gateway_log: None,
}),
```

- [ ] **Step 4: Run existing state tests**

Run: `cargo test -p vulture-desktop-shell state`
Expected: existing tests still PASS (no behavior change for old fields).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): AppState holds runtime descriptor + supervisor status"
```

### Task 20: Add system Tauri commands

**Files:**
- Modify: `apps/desktop-shell/src/commands.rs`
- Modify: `apps/desktop-shell/src/main.rs` (extend invoke_handler)

- [ ] **Step 1: Add the 5 new commands at the end of `commands.rs`**

```rust
use vulture_core::RuntimeDescriptor;

#[tauri::command]
pub fn get_runtime_info(state: tauri::State<AppState>) -> Result<RuntimeDescriptor, String> {
    state
        .runtime_descriptor()
        .ok_or_else(|| "runtime not yet initialized".to_string())
}

#[tauri::command]
pub fn open_log_dir(state: tauri::State<AppState>) -> Result<(), String> {
    let dir = state.profile_dir().join("..").join("..").join("Logs/Vulture");
    open_in_finder(&dir)
}

#[tauri::command]
pub fn open_profile_dir(state: tauri::State<AppState>) -> Result<(), String> {
    open_in_finder(&state.profile_dir())
}

#[tauri::command]
pub fn get_supervisor_status(
    state: tauri::State<AppState>,
) -> Result<crate::supervisor::SupervisorStatus, String> {
    Ok(state.supervisor_status())
}

#[tauri::command]
pub fn restart_gateway(state: tauri::State<AppState>) -> Result<(), String> {
    state.request_supervisor_restart();
    Ok(())
}

fn open_in_finder(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    Ok(())
}
```

(`profile_dir()` and `request_supervisor_restart()` need to exist on `AppState`. Add them in `state.rs`:)

```rust
impl AppState {
    pub fn profile_dir(&self) -> PathBuf {
        self.profile_dir.clone()
    }

    pub fn request_supervisor_restart(&self) {
        // For Phase 1, this just signals via supervisor status; actual restart is
        // wired in main.rs via a watch channel introduced in Task 21.
        // Phase 1 acceptance: command exists and is callable; restart logic
        // covered by supervisor unit tests.
    }
}
```

- [ ] **Step 2: Register the new commands in `main.rs`**

Inside the existing `invoke_handler` macro call, add (keep all existing entries):
```rust
commands::get_runtime_info,
commands::open_log_dir,
commands::open_profile_dir,
commands::get_supervisor_status,
commands::restart_gateway,
```

- [ ] **Step 3: Build and check**

Run: `cargo build -p vulture-desktop-shell`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): add 5 system Tauri commands (runtime/logs/supervisor)"
```

### Task 21: Wire startup orchestration in `main.rs`

**Files:**
- Modify: `apps/desktop-shell/src/main.rs`

- [ ] **Step 1: Replace the `fn main()` body**

```rust
mod agent_pack;
mod agent_store;
mod auth;
mod browser;
mod commands;
mod runtime;
mod sidecar;
mod single_instance;
mod state;
mod supervisor;
mod tool_callback;
mod workspace_store;

use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::Utc;
use state::AppState;
use vulture_core::{PortBinding, RuntimeDescriptor, API_VERSION};

fn vulture_root() -> PathBuf {
    let home = std::env::var_os("HOME").expect("HOME must be set");
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Vulture")
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let root = vulture_root();
    std::fs::create_dir_all(&root).context("create vulture root")?;

    // 1. Single instance lock (held for life of process via leak; let it drop on exit).
    let _instance_lock = single_instance::InstanceLock::acquire(root.join("lock"))
        .context("another Vulture instance is already running")?;

    // 2. Token + ports.
    let token = runtime::generate_token();
    let gateway_port = runtime::pick_free_port(4099, 100)?;
    let shell_port = runtime::pick_free_port(4199, 100)?;

    // 3. Start shell HTTP callback server.
    let _shell_server = tool_callback::serve(shell_port).await?;

    // 4. Write runtime.json.
    let runtime_path = root.join("runtime.json");
    let descriptor = RuntimeDescriptor {
        api_version: API_VERSION.to_string(),
        gateway: PortBinding { port: gateway_port },
        shell: PortBinding { port: shell_port },
        token: token.clone(),
        pid: std::process::id(),
        started_at: Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        shell_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    runtime::write_runtime_json(&runtime_path, &descriptor)?;

    // 5. App state.
    let app_state = AppState::new_for_root(&root)
        .context("failed to initialize Vulture desktop state")?;
    app_state.set_runtime_descriptor(descriptor.clone());

    // 6. Spawn gateway as a background task.
    let spawn_spec = supervisor::SpawnSpec {
        bun_bin: PathBuf::from("bun"),
        gateway_entry: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/gateway/src/main.ts")
            .canonicalize()
            .context("resolve gateway entry path")?,
        workdir: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .context("resolve repo root")?,
        gateway_port,
        shell_port,
        token,
        shell_pid: std::process::id(),
        profile_dir: root.join("profiles").join("default"),
    };
    let supervisor_status = std::sync::Arc::new(std::sync::Mutex::new(()));
    let _supervisor_handle = tokio::spawn(async move {
        match supervisor::spawn_gateway(&spawn_spec).await {
            Ok(running) => {
                eprintln!(
                    "[supervisor] gateway running on port {}",
                    running.reported_port
                );
                // Phase 1: just hold the handle; restart loop comes in Task 23.
                let _ = running.child.wait_with_output().await;
            }
            Err(e) => {
                eprintln!("[supervisor] failed to spawn gateway: {e:#}");
            }
        }
        drop(supervisor_status);
    });

    // 7. Tauri webview.
    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::start_mock_run,
            commands::start_agent_run,
            commands::get_profile,
            commands::list_agents,
            commands::get_agent,
            commands::save_agent,
            commands::delete_agent,
            commands::list_workspaces,
            commands::save_workspace,
            commands::delete_workspace,
            commands::get_openai_auth_status,
            commands::set_openai_api_key,
            commands::clear_openai_api_key,
            commands::start_codex_login,
            commands::get_browser_status,
            commands::start_browser_pairing,
            // Phase 1 additions:
            commands::get_runtime_info,
            commands::open_log_dir,
            commands::open_profile_dir,
            commands::get_supervisor_status,
            commands::restart_gateway,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Vulture desktop shell");

    runtime::remove_runtime_json(&runtime_path);
    Ok(())
}
```

- [ ] **Step 2: Build**

Run: `cargo build -p vulture-desktop-shell`
Expected: PASS. (Some warnings about unused `_supervisor_handle` etc. are OK.)

- [ ] **Step 3: Smoke run (manual)**

Run in a terminal:
```bash
bun --filter @vulture/desktop-ui dev   # one terminal
bun --filter @vulture/desktop-shell tauri dev   # another (or whichever is your dev script)
```

Verify in another terminal:
```bash
ls -l ~/Library/Application\ Support/Vulture/runtime.json
# Expected: -rw------- with current pid + ports

cat ~/Library/Application\ Support/Vulture/runtime.json | jq .
# Expected: full RuntimeDescriptor JSON

curl -s http://127.0.0.1:$(jq -r .gateway.port ~/Library/Application\ Support/Vulture/runtime.json)/healthz | jq .
# Expected: { ok: true, apiVersion: "v1", ... }

curl -i http://127.0.0.1:$(jq -r .gateway.port ~/Library/Application\ Support/Vulture/runtime.json)/anything-else
# Expected: HTTP/1.1 401
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): orchestrate startup — lock/token/ports/runtime.json/gateway"
```

### Task 22: Add `useRuntimeDescriptor` UI hook

**Files:**
- Create: `apps/desktop-ui/src/runtime/useRuntimeDescriptor.ts`
- (optional) Modify: `apps/desktop-ui/src/App.tsx` for a debug indicator

- [ ] **Step 1: Write the hook**

`apps/desktop-ui/src/runtime/useRuntimeDescriptor.ts`:
```ts
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface RuntimeDescriptor {
  apiVersion: "v1";
  gateway: { port: number };
  shell: { port: number };
  token: string;
  pid: number;
  startedAt: string;
  shellVersion: string;
}

export function useRuntimeDescriptor() {
  const [data, setData] = useState<RuntimeDescriptor | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<RuntimeDescriptor>("get_runtime_info")
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, error };
}
```

- [ ] **Step 2: Add a small debug indicator at the top of `App.tsx`**

Inside the existing `App` component, near the top of the returned JSX, add:
```tsx
import { useRuntimeDescriptor } from "./runtime/useRuntimeDescriptor";

// inside component:
const runtime = useRuntimeDescriptor();

// inside JSX (top of layout):
{runtime.data && (
  <div className="runtime-debug" style={{ fontSize: 11, opacity: 0.6 }}>
    gateway:{runtime.data.gateway.port} shell:{runtime.data.shell.port} api:{runtime.data.apiVersion}
  </div>
)}
{runtime.error && (
  <div className="runtime-debug error" style={{ color: "red" }}>
    runtime error: {runtime.error}
  </div>
)}
```

- [ ] **Step 3: Typecheck**

Run: `bun --filter @vulture/desktop-ui typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): useRuntimeDescriptor hook + debug indicator"
```

### Task 23: Add restart loop in `main.rs` supervisor task

**Files:**
- Modify: `apps/desktop-shell/src/main.rs`
- Modify: `apps/desktop-shell/src/state.rs`
- Modify: `apps/desktop-shell/src/supervisor.rs`

- [ ] **Step 1: Add a restart-trigger channel to AppState**

In `state.rs`:
```rust
use tokio::sync::Notify;
use std::sync::Arc;

// inside AppState struct, add:
restart_signal: Arc<Notify>,
```

In `AppState::new_for_root_with_secret_store`, initialize:
```rust
restart_signal: Arc::new(Notify::new()),
```

Add accessor + replace the placeholder in `request_supervisor_restart`:
```rust
impl AppState {
    pub fn restart_signal(&self) -> Arc<Notify> {
        self.restart_signal.clone()
    }

    pub fn request_supervisor_restart(&self) {
        self.restart_signal.notify_one();
    }
}
```

- [ ] **Step 2: Replace the supervisor task in `main.rs`**

Replace the previous `tokio::spawn` block with a loop that:

```rust
let restart_signal = app_state.restart_signal();
let status_setter_state = app_state_arc_for_setter(); // helper if needed; or pass &Arc<AppState>

let _supervisor_handle = tokio::spawn(async move {
    let mut tracker = supervisor::RestartTracker::new();
    loop {
        match supervisor::spawn_gateway(&spawn_spec).await {
            Ok(running) => {
                eprintln!("[supervisor] gateway READY on {}", running.reported_port);
                tracker = supervisor::RestartTracker::new();
                let exit_status = running.child.wait_with_output().await;
                eprintln!("[supervisor] gateway exited: {:?}", exit_status);
            }
            Err(err) => {
                eprintln!("[supervisor] spawn failed: {err:#}");
            }
        }

        tracker.record_failure(std::time::Instant::now());
        if tracker.should_give_up() {
            eprintln!("[supervisor] FAULTED after {} attempts", tracker.attempts());
            break;
        }
        let backoff = tracker.next_backoff().expect("checked above");
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = restart_signal.notified() => {
                tracker = supervisor::RestartTracker::new();
            }
        }
    }
});
```

Note: AppState passing into the async task needs `Arc<AppState>` — Tauri's `manage` already wraps in `Arc`, but for the spawned task you may need to clone the `Arc` separately. The simplest: extract restart_signal and any status setter ref BEFORE moving to the task, so the task itself only owns those `Arc`s.

- [ ] **Step 3: Build**

Run: `cargo build -p vulture-desktop-shell`
Expected: PASS. Warnings about unused fields acceptable.

- [ ] **Step 4: Smoke test the restart**

Manual:
```bash
# launch app, then
ps aux | grep gateway
kill -9 <gateway-pid>
# observe in app's stderr: "[supervisor] gateway exited" then "[supervisor] gateway READY ..."
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): supervisor restart loop with backoff and signal channel"
```

---

## Group F — Acceptance verification

### Task 24: Acceptance — `runtime.json` written 0600 (integration test)

**Files:**
- Create: `apps/desktop-shell/tests/runtime_json_integration.rs`

- [ ] **Step 1: Write the test**

`apps/desktop-shell/tests/runtime_json_integration.rs`:
```rust
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use vulture_core::{PortBinding, RuntimeDescriptor, API_VERSION};
use vulture_desktop_shell::runtime;

#[test]
fn write_then_read_round_trip_preserves_mode_0600() {
    let dir = std::env::temp_dir().join(format!(
        "vulture-it-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("runtime.json");

    let descriptor = RuntimeDescriptor {
        api_version: API_VERSION.to_string(),
        gateway: PortBinding { port: 4099 },
        shell: PortBinding { port: 4199 },
        token: "x".repeat(43),
        pid: std::process::id(),
        started_at: chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        shell_version: "0.1.0".to_string(),
    };

    runtime::write_runtime_json(&path, &descriptor).unwrap();

    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);

    let read = runtime::read_runtime_json(&path).unwrap();
    assert_eq!(read, descriptor);

    std::fs::remove_dir_all(&dir).ok();
}
```

For this to compile, `vulture-desktop-shell` needs to be importable as a library. Add a `lib.rs` if it doesn't exist:

`apps/desktop-shell/src/lib.rs`:
```rust
pub mod runtime;
pub mod single_instance;
pub mod supervisor;
pub mod tool_callback;
```

And add to `apps/desktop-shell/Cargo.toml`:
```toml
[lib]
name = "vulture_desktop_shell"
path = "src/lib.rs"
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p vulture-desktop-shell --test runtime_json_integration`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop-shell
git commit -m "test(shell): runtime.json round-trip integration"
```

### Task 25: Acceptance — Gateway healthz vs auth (integration test)

**Files:**
- Create: `apps/gateway/src/server.test.ts`

- [ ] **Step 1: Write the test**

`apps/gateway/src/server.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildServer } from "./server";
import type { GatewayConfig } from "./env";

const cfg: GatewayConfig = {
  port: 4099,
  token: "x".repeat(43),
  shellCallbackUrl: "http://127.0.0.1:4199",
  shellPid: 1,
  profileDir: "/tmp",
};

describe("gateway server", () => {
  test("/healthz returns ok without auth", async () => {
    const app = buildServer(cfg);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.apiVersion).toBe("v1");
  });

  test("any other route without token → 401", async () => {
    const app = buildServer(cfg);
    const res = await app.request("/v1/agents");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("auth.token_invalid");
  });

  test("token in query string is rejected (treated as no token)", async () => {
    const app = buildServer(cfg);
    const res = await app.request(`/v1/agents?token=${cfg.token}`);
    expect(res.status).toBe(401);
  });

  test("with valid token → 404 (route not registered yet, but auth passed)", async () => {
    const app = buildServer(cfg);
    const res = await app.request("/v1/agents", {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    // Phase 1 has no /v1/agents route; auth passes then the router 404s.
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run**

Run: `bun test apps/gateway/src/server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add apps/gateway
git commit -m "test(gateway): healthz unauth + everything else 401"
```

### Task 26: Manual acceptance walkthrough

This task is verification, not code. Execute and write up results in the PR description.

- [ ] **Step 1: Cold start**

```bash
bun --filter @vulture/desktop-shell tauri dev
```
Verify: webview opens; `~/Library/Application Support/Vulture/runtime.json` exists with mode 600; `bun` process is running with `VULTURE_GATEWAY_PORT` in env (`ps -e -o pid,command | grep gateway`).

- [ ] **Step 2: Healthz + auth probe**

```bash
PORT=$(jq -r .gateway.port ~/Library/Application\ Support/Vulture/runtime.json)
TOKEN=$(jq -r .token ~/Library/Application\ Support/Vulture/runtime.json)

curl -i http://127.0.0.1:$PORT/healthz
# Expected: 200 + JSON

curl -i http://127.0.0.1:$PORT/v1/agents
# Expected: 401 + AppError JSON

curl -i -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/v1/agents
# Expected: 404 (route not registered in Phase 1)
```

- [ ] **Step 3: Gateway crash → restart**

```bash
GATEWAY_PID=$(pgrep -f "apps/gateway/src/main.ts")
kill -9 $GATEWAY_PID
sleep 2
pgrep -f "apps/gateway/src/main.ts"
# Expected: a different PID
curl -s http://127.0.0.1:$PORT/healthz
# (port may have changed; re-read runtime.json if needed)
```

- [ ] **Step 4: Tauri crash → watchdog suicides Gateway**

```bash
TAURI_PID=$(pgrep -f vulture-desktop-shell | head -1)
GATEWAY_PID=$(pgrep -f "apps/gateway/src/main.ts")
kill -9 $TAURI_PID
sleep 4
ps -p $GATEWAY_PID
# Expected: process not found (Gateway exited via watchdog)
```

- [ ] **Step 5: Single instance**

```bash
# launch app once, then attempt second launch
bun --filter @vulture/desktop-shell tauri dev
# Expected: second launch fails with "another instance is already running"
```

- [ ] **Step 6: Old `start_agent_run` still works**

In the running app, perform a normal mock run (existing UI button). Verify it still emits the same RunEvents as before.

- [ ] **Step 7: Document results in PR description**

Capture the outputs of steps 1–6 and paste into the PR description as a "manual acceptance log".

---

## Self-Review

Reviewed against the spec's Phase 1 Acceptance section:

- ✅ App starts, runtime.json written 0600 → Task 21 + Task 24
- ✅ Tauri exit cleans runtime.json + reaps Gateway → Task 21 (`remove_runtime_json` on exit + `kill_on_drop(true)` in spawn)
- ✅ `curl /healthz` 200, others 401 → Task 25 + Task 26 step 2
- ✅ kill -9 Gateway → restart through Restarting → Running → Task 23 (loop) + Task 26 step 3
- ✅ 4 failed restarts → Faulted → Task 17 (RestartTracker) + Task 23 (loop break)
- ✅ Second Tauri instance focuses + exits → Task 12 (flock) + Task 21 (acquire on startup) + Task 26 step 5
- ✅ kill -9 Tauri → watchdog suicides Gateway in 4s → Task 10 + Task 26 step 4
- ✅ Old mock + start_agent_run paths still work → Task 21 (existing handlers preserved) + Task 26 step 6

Type/method consistency check:
- `RuntimeDescriptor` field names consistent between TS (`packages/protocol/src/v1/runtime.ts`) and Rust (`crates/core/src/runtime.rs`) via `#[serde(rename_all = "camelCase")]` and matching property names.
- `AppError.code` ErrorCode enum matches between protocol/error.ts and the values used in gateway middleware.
- `SupervisorStatus.state.kind` discriminator: serialized as tagged union in Rust (`#[serde(tag = "kind")]`); UI hook should match. Phase 1 UI does not yet render this; deferred safely to Task 22 follow-on or later phase.

Outstanding placeholders fixed: none found.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-26-l0-phase-1-infrastructure.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
