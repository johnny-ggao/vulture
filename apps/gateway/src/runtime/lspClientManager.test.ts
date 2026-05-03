import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLspClientManager, type LspClientManager } from "./lspClientManager";
import type { LspTransport } from "./lspServerHandle";

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
    writeFileSync(join(root, "README.md"), "# hi");
    const result = await mgr.diagnostics(root, join(root, "README.md"));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("lsp.unsupported_language");
  });

  test("path outside workspace returns lsp.path_outside_workspace", async () => {
    mgr = createLspClientManager({
      idleTtlMs: 60_000,
      sweepIntervalMs: 60_000,
      transportFactory: async () => new StubTransport(),
    });
    const result = await mgr.diagnostics(root, "/etc/passwd.ts");
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("lsp.path_outside_workspace");
  });

  test("server_not_found when transportFactory returns null", async () => {
    mgr = createLspClientManager({
      idleTtlMs: 60_000,
      sweepIntervalMs: 60_000,
      transportFactory: async () => null,
    });
    const result = await mgr.diagnostics(root, join(root, "src", "a.ts"));
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("lsp.server_not_found");
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
    expect(mgr.cacheSize()).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(mgr.cacheSize()).toBe(0);
  });

  test("subsequent calls reuse cached handle", async () => {
    const transports: StubTransport[] = [];
    mgr = createLspClientManager({
      idleTtlMs: 60_000,
      sweepIntervalMs: 60_000,
      transportFactory: async () => {
        const t = new StubTransport();
        transports.push(t);
        return t;
      },
    });
    await mgr.hover(root, join(root, "src", "a.ts"), 0, 0);
    await mgr.definition(root, join(root, "src", "a.ts"), 0, 0);
    expect(transports.length).toBe(1);
  });
});
