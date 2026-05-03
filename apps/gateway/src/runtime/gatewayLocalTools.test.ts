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
  test("read/write/edit operate inside the workspace without approvals in default mode", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({ shellTools: async () => "shell" });

    await tools({
      callId: "c-write",
      runId: "r",
      tool: "write",
      workspacePath,
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
      input: {
        path: join(workspacePath, "note.txt"),
        oldText: "hello",
        newText: "hello world",
        replaceAll: null,
      },
    });

    expect(await readFile(join(workspacePath, "note.txt"), "utf8")).toBe("hello world");
  });

  test("write outside the workspace is rejected without an approval token", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({ shellTools: async () => "shell" });

    await expect(
      tools({
        callId: "c-write",
        runId: "r",
        tool: "write",
        workspacePath,
        input: { path: "/etc/hosts", content: "hello" },
      }),
    ).rejects.toThrow("write outside workspace");
  });

  test("read-only mode requires approval before workspace writes", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({ shellTools: async () => "shell" });

    await expect(
      tools({
        callId: "c-write",
        runId: "r",
        tool: "write",
        workspacePath,
        permissionMode: "read_only",
        input: { path: join(workspacePath, "note.txt"), content: "hello" },
      }),
    ).rejects.toThrow("write requires approval in read-only mode");
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

  test("public web_fetch and web_search use injected fetch without approval", async () => {
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
    ).resolves.toMatchObject({ url: "https://example.com/", content: "<h1>Hello</h1>" });

    await expect(
      tools({
        callId: "c-search",
        runId: "r",
        tool: "web_search",
        workspacePath,
        input: { query: "example", limit: null },
      }),
    ).resolves.toMatchObject({
      provider: "duckduckgo-html",
      results: [{ title: "Example A", url: "https://example.com/a" }],
    });
  });

  test("public web_extract returns structured page content", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({
      shellTools: async () => "shell",
      fetch: async () =>
        new Response(
          '<html><head><title>Hello</title></head><body><main><p>Readable text</p><a href="/next">Next</a></main></body></html>',
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    });

    await expect(
      tools({
        callId: "c-extract",
        runId: "r",
        tool: "web_extract",
        workspacePath,
        input: { url: "https://example.com/page", maxBytes: null, maxLinks: 10 },
      }),
    ).resolves.toMatchObject({
      url: "https://example.com/page",
      title: "Hello",
      text: "Readable text Next",
      links: [{ text: "Next", url: "https://example.com/next" }],
    });
  });

  test("private web_fetch requires approval", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({
      shellTools: async () => "shell",
      fetch: async () => new Response("private", { status: 200 }),
    });

    await expect(
      tools({
        callId: "c-fetch",
        runId: "r",
        tool: "web_fetch",
        workspacePath,
        input: { url: "http://localhost:3000", maxBytes: null },
      }),
    ).rejects.toThrow("web_fetch private host requires approval");

    await expect(
      tools({
        callId: "c-fetch-approved",
        runId: "r",
        tool: "web_fetch",
        workspacePath,
        approvalToken: "approved",
        input: { url: "http://localhost:3000", maxBytes: null },
      }),
    ).resolves.toMatchObject({ content: "private" });
  });

  test("sessions and update_plan use gateway stores when provided", async () => {
    const workspacePath = await tempWorkspace();
    const seenCalls: Array<{ tool: string; runId?: string; callId?: string; input?: unknown }> = [];
    const tools = makeGatewayLocalTools({
      shellTools: async () => "shell",
      sessions: {
        list: (call) => {
          seenCalls.push({
            tool: "sessions_list",
            runId: call.runId,
            callId: call.callId,
            input: call.input,
          });
          return [{ id: "c1", title: "Main", agentId: "a1" }];
        },
        history: (call) => {
          seenCalls.push({ tool: "sessions_history", runId: call.runId, input: call.input });
          return [{ role: "user", content: "hello" }];
        },
        send: async (call) => {
          seenCalls.push({ tool: "sessions_send", runId: call.runId, input: call.input });
          return { sessionId: (call.input as { sessionId?: string }).sessionId, conversationId: "c1", runId: "r2" };
        },
        spawn: async (call) => {
          seenCalls.push({ tool: "sessions_spawn", runId: call.runId, input: call.input });
          return { conversationId: "c2", runId: null };
        },
        yield: (call) => {
          seenCalls.push({ tool: "sessions_yield", runId: call.runId, input: call.input });
          return {
            active: [],
            completed: [{ sessionId: "sub-1", resultSummary: "child result" }],
            failed: [],
          };
        },
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
        callId: "c-session-send",
        runId: "r-parent",
        tool: "sessions_send",
        workspacePath,
        approvalToken: "approved",
        input: { sessionId: "sub-1", message: "continue" },
      }),
    ).resolves.toMatchObject({ sessionId: "sub-1", runId: "r2" });

    expect(seenCalls).toContainEqual({
      tool: "sessions_list",
      runId: "r",
      callId: "c-sessions",
      input: { limit: null },
    });
    expect(seenCalls).toContainEqual({
      tool: "sessions_send",
      runId: "r-parent",
      input: { sessionId: "sub-1", message: "continue" },
    });

    await expect(
      tools({
        callId: "c-session-yield",
        runId: "r-parent",
        tool: "sessions_yield",
        workspacePath,
        input: { parentRunId: "r-parent" },
      }),
    ).resolves.toEqual({
      active: [],
      completed: [{ sessionId: "sub-1", resultSummary: "child result" }],
      failed: [],
    });

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

  test("dispatches grep to runGrep", async () => {
    const workspacePath = await tempWorkspace();
    await writeFile(join(workspacePath, "a.ts"), "const foo = 1;\n");
    const tools = makeGatewayLocalTools({ shellTools: async () => "shell" });
    const result = await tools({
      callId: "c1",
      runId: "r1",
      tool: "grep",
      input: { pattern: "foo", path: workspacePath, regex: false },
      workspacePath,
    }) as { matches: unknown[] };
    expect(result.matches.length).toBeGreaterThan(0);
  });

  test("dispatches glob to runGlob", async () => {
    const workspacePath = await tempWorkspace();
    await writeFile(join(workspacePath, "a.ts"), "");
    await writeFile(join(workspacePath, "b.md"), "");
    const tools = makeGatewayLocalTools({ shellTools: async () => "shell" });
    const result = await tools({
      callId: "c2",
      runId: "r1",
      tool: "glob",
      input: { pattern: "**/*.ts", path: workspacePath },
      workspacePath,
    }) as { paths: string[] };
    expect(result.paths.length).toBe(1);
  });

  test("lsp.diagnostics returns structured error when lspManager is not configured", async () => {
    const workspacePath = await tempWorkspace();
    const tools = makeGatewayLocalTools({ shellTools: async () => "shell" });
    await expect(
      tools({
        callId: "c3",
        runId: "r1",
        tool: "lsp.diagnostics",
        input: { filePath: "/tmp/x.ts" },
        workspacePath,
      }),
    ).rejects.toThrow(/lsp.unavailable|lsp manager|not configured/i);
  });

  test("lsp.* dispatch routes to correct lspManager method", async () => {
    const workspacePath = await tempWorkspace();
    const calls: string[] = [];
    const stubManager = {
      diagnostics: async () => {
        calls.push("diagnostics");
        return { kind: "ok" as const, value: [] };
      },
      definition: async () => {
        calls.push("definition");
        return { kind: "ok" as const, value: [] };
      },
      references: async () => {
        calls.push("references");
        return { kind: "ok" as const, value: [] };
      },
      hover: async () => {
        calls.push("hover");
        return { kind: "ok" as const, value: null };
      },
      cacheSize: () => 0,
      dispose: async () => {},
    };
    const tools = makeGatewayLocalTools({
      shellTools: async () => "shell",
      lspManager: stubManager,
    });
    const base = { runId: "r1", workspacePath, permissionMode: "default" as const };
    await tools({
      ...base,
      callId: "1",
      tool: "lsp.diagnostics",
      input: { filePath: join(workspacePath, "a.ts") },
    });
    await tools({
      ...base,
      callId: "2",
      tool: "lsp.definition",
      input: { filePath: join(workspacePath, "a.ts"), line: 0, character: 0 },
    });
    await tools({
      ...base,
      callId: "3",
      tool: "lsp.references",
      input: { filePath: join(workspacePath, "a.ts"), line: 0, character: 0 },
    });
    await tools({
      ...base,
      callId: "4",
      tool: "lsp.hover",
      input: { filePath: join(workspacePath, "a.ts"), line: 0, character: 0 },
    });
    expect(calls).toEqual(["diagnostics", "definition", "references", "hover"]);
  });

  test("MCP tools execute through injected MCP service and emit normal tool events", async () => {
    const workspacePath = await tempWorkspace();
    const events: unknown[] = [];
    const tools = makeGatewayLocalTools({
      shellTools: async () => "shell",
      appendEvent: (_runId, event) => events.push(event),
      mcp: {
        canHandle: (toolName) => toolName === "mcp_echo_server_echo",
        execute: async (call) => ({
          echoed: call.input,
          approvalToken: call.approvalToken,
        }),
      },
    });

    await expect(
      tools({
        callId: "c-mcp",
        runId: "r",
        tool: "mcp_echo_server_echo",
        workspacePath,
        approvalToken: "approved",
        input: { text: "hello" },
      }),
    ).resolves.toEqual({
      echoed: { text: "hello" },
      approvalToken: "approved",
    });

    expect(events).toEqual([
      {
        type: "tool.planned",
        callId: "c-mcp",
        tool: "mcp_echo_server_echo",
        input: { text: "hello" },
      },
      { type: "tool.started", callId: "c-mcp" },
      {
        type: "tool.completed",
        callId: "c-mcp",
        output: {
          echoed: { text: "hello" },
          approvalToken: "approved",
        },
      },
    ]);
  });
});
