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
    // Use a temp file we can read; create-and-clean via fs
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "lsp-handle-"));
    const file = join(dir, "a.ts");
    writeFileSync(file, "// content\n");
    try {
      await handle.ensureOpen(file, "typescript");
      await handle.ensureOpen(file, "typescript");
      const opens = t.sent.filter((s) => s.method === "textDocument/didOpen");
      expect(opens.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dispose sends shutdown then exit before closing transport", async () => {
    const t = new FakeTransport();
    t.responders["initialize"] = () => ({ capabilities: {} });
    const handle = new LspServerHandle(t, "/repo", "typescript");
    await handle.ready();
    t.sent.length = 0; // 清除 init 消息
    await handle.dispose();
    const methods = t.sent.map((s) => s.method);
    expect(methods[0]).toBe("shutdown");
    expect(methods[1]).toBe("exit");
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
