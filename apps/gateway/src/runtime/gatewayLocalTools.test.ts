import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { makeGatewayLocalTools } from "./gatewayLocalTools";

const tempDirs: string[] = [];

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vulture-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("gateway local tools", () => {
  test("read/write/edit operate inside the workspace with write approvals", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({ shellTools: async () => "shell" });

    await tools({
      callId: "c-write",
      runId: "r",
      tool: "write",
      workspacePath,
      approvalToken: "approved",
      input: { path: join(workspacePath, "note.txt"), content: "hello" },
    });

    const read = await tools({
      callId: "c-read",
      runId: "r",
      tool: "read",
      workspacePath,
      input: { path: join(workspacePath, "note.txt"), maxBytes: null },
    });
    expect(read).toMatchObject({ content: "hello" });

    await tools({
      callId: "c-edit",
      runId: "r",
      tool: "edit",
      workspacePath,
      approvalToken: "approved",
      input: {
        path: join(workspacePath, "note.txt"),
        oldText: "hello",
        newText: "hello world",
        replaceAll: null,
      },
    });

    expect(await readFile(join(workspacePath, "note.txt"), "utf8")).toBe("hello world");
  });

  test("write is rejected without an approval token", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({ shellTools: async () => "shell" });

    await expect(
      tools({
        callId: "c-write",
        runId: "r",
        tool: "write",
        workspacePath,
        input: { path: join(workspacePath, "note.txt"), content: "hello" },
      }),
    ).rejects.toThrow("write requires approval");
  });

  test("apply_patch applies a unified diff in the workspace", async () => {
    const workspacePath = await tempWorkspace();
    await writeFile(join(workspacePath, "note.txt"), "alpha\nbeta\n");
    const tools = makeGatewayLocalTools({ shellTools: async () => "shell" });

    await tools({
      callId: "c-patch",
      runId: "r",
      tool: "apply_patch",
      workspacePath,
      approvalToken: "approved",
      input: {
        cwd: workspacePath,
        patch:
          "--- a/note.txt\n+++ b/note.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n",
      },
    });

    expect(await readFile(join(workspacePath, "note.txt"), "utf8")).toBe("alpha\ngamma\n");
  });

  test("process can start, read, list, and stop a background process", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({ shellTools: async () => "shell" });

    const started = await tools({
      callId: "c-process-start",
      runId: "r",
      tool: "process",
      workspacePath,
      approvalToken: "approved",
      input: {
        action: "start",
        cwd: workspacePath,
        argv: ["node", "-e", "console.log('ready'); setTimeout(() => {}, 30000)"],
        processId: null,
      },
    }) as { processId: string };

    expect(started.processId).toStartWith("p-");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const output = await tools({
      callId: "c-process-read",
      runId: "r",
      tool: "process",
      workspacePath,
      input: { action: "read", processId: started.processId, cwd: null, argv: null },
    }) as { stdout: string };
    expect(output.stdout).toContain("ready");

    const list = await tools({
      callId: "c-process-list",
      runId: "r",
      tool: "process",
      workspacePath,
      input: { action: "list", processId: null, cwd: null, argv: null },
    }) as { items: Array<{ processId: string }> };
    expect(list.items.map((item) => item.processId)).toContain(started.processId);

    await tools({
      callId: "c-process-stop",
      runId: "r",
      tool: "process",
      workspacePath,
      approvalToken: "approved",
      input: { action: "stop", processId: started.processId, cwd: null, argv: null },
    });
  });

  test("web_fetch and web_search use injected fetch", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({
      shellTools: async () => "shell",
      fetch: async (url) => {
        const href = String(url);
        if (href.includes("duckduckgo")) {
          return new Response(
            '<a class="result__a" href="https://example.com/a">Example A</a>',
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        return new Response("<h1>Hello</h1>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });

    await expect(
      tools({
        callId: "c-fetch",
        runId: "r",
        tool: "web_fetch",
        workspacePath,
        input: { url: "https://example.com", maxBytes: null },
      }),
    ).resolves.toMatchObject({ url: "https://example.com", content: "<h1>Hello</h1>" });

    await expect(
      tools({
        callId: "c-search",
        runId: "r",
        tool: "web_search",
        workspacePath,
        input: { query: "example", limit: null },
      }),
    ).resolves.toMatchObject({ results: [{ title: "Example A", url: "https://example.com/a" }] });
  });

  test("sessions and update_plan use gateway stores when provided", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({
      shellTools: async () => "shell",
      sessions: {
        list: () => [{ id: "c1", title: "Main", agentId: "a1" }],
        history: () => [{ role: "user", content: "hello" }],
        send: async () => ({ conversationId: "c1", runId: "r2" }),
        spawn: async () => ({ conversationId: "c2", runId: null }),
        yield: () => ({ activeRuns: [] }),
      },
    });

    await expect(
      tools({
        callId: "c-sessions",
        runId: "r",
        tool: "sessions_list",
        workspacePath,
        input: { limit: null },
      }),
    ).resolves.toMatchObject({ items: [{ id: "c1", title: "Main" }] });

    await expect(
      tools({
        callId: "c-plan",
        runId: "r",
        tool: "update_plan",
        workspacePath,
        input: { items: [{ step: "Implement tools", status: "in_progress" }] },
      }),
    ).resolves.toMatchObject({ items: [{ step: "Implement tools", status: "in_progress" }] });
  });

  test("memory tools use gateway memory service and require approval for append", async () => {
    const workspacePath = await tempWorkspace();
    const calls: string[] = [];
    const tools = makeGatewayLocalTools({
      shellTools: async () => "shell",
      memory: {
        search: async (call) => {
          calls.push(`search:${call.workspacePath}`);
          return { items: [{ id: "memchunk-1", path: "MEMORY.md", snippet: "Project codename is Vulture." }] };
        },
        get: async (call) => {
          calls.push(`get:${call.workspacePath}`);
          return { path: "MEMORY.md", content: "Project codename is Vulture." };
        },
        append: async (call) => {
          calls.push(`append:${call.workspacePath}`);
          return { path: "MEMORY.md", bytes: 21 };
        },
      },
    });

    await expect(
      tools({
        callId: "c-memory-search",
        runId: "r",
        tool: "memory_search",
        workspacePath,
        input: { query: "codename", limit: null },
      }),
    ).resolves.toMatchObject({ items: [{ id: "memchunk-1" }] });

    await expect(
      tools({
        callId: "c-memory-get",
        runId: "r",
        tool: "memory_get",
        workspacePath,
        input: { id: "memchunk-1", path: null },
      }),
    ).resolves.toMatchObject({ content: "Project codename is Vulture." });

    await expect(
      tools({
        callId: "c-memory-append-denied",
        runId: "r",
        tool: "memory_append",
        workspacePath,
        input: { path: "MEMORY.md", content: "- Remember this." },
      }),
    ).rejects.toThrow("memory_append requires approval");

    await expect(
      tools({
        callId: "c-memory-append",
        runId: "r",
        tool: "memory_append",
        workspacePath,
        approvalToken: "approved",
        input: { path: "MEMORY.md", content: "- Remember this." },
      }),
    ).resolves.toMatchObject({ path: "MEMORY.md" });

    expect(calls).toEqual([
      `search:${workspacePath}`,
      `get:${workspacePath}`,
      `append:${workspacePath}`,
    ]);
  });
});
