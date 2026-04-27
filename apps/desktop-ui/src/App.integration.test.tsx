import { describe, expect, test, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock Tauri's invoke before importing App so useRuntimeDescriptor + the
// auth-status invoke return stable values.
const TOKEN = "x".repeat(43);
const FAKE_RUNTIME = {
  apiVersion: "v1",
  gateway: { port: 4099 },
  shell: { port: 4199 },
  token: TOKEN,
  pid: 12345,
  startedAt: "2026-04-27T00:00:00.000Z",
  shellVersion: "0.1.0",
};

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "get_runtime_info") return FAKE_RUNTIME;
    if (cmd === "get_auth_status") {
      return {
        active: "none",
        codex: { state: "not_signed_in" },
        apiKey: { state: "not_set" },
      };
    }
    if (cmd === "get_openai_auth_status") {
      return { configured: false, source: "missing" };
    }
    if (cmd === "start_chatgpt_login") {
      return { url: "", alreadyAuthenticated: false };
    }
    if (cmd === "sign_out_chatgpt") return undefined;
    if (cmd === "set_openai_api_key") {
      return { configured: true, source: "keychain" };
    }
    if (cmd === "clear_openai_api_key") {
      return { configured: false, source: "missing" };
    }
    throw new Error(`unmocked invoke: ${cmd}`);
  },
}));

// After the mock is in place, dynamic-import App + buildServer so the mock
// applies. (Static imports above the mock would race the mock setup.)
const [{ App }, { buildServer }] = await Promise.all([
  import("./App"),
  import("../../gateway/src/server"),
]);
const { readActiveChatState, writeActiveChatState, writeRunLastSeq } = await import("./chat/recoveryState");

const { render, screen, fireEvent, waitFor } = await import(
  "@testing-library/react/pure"
);

function setup(
  opts: {
    onRequest?: (path: string, init?: RequestInit) => void;
    onResponse?: (path: string, init: RequestInit | undefined) => void;
  } = {},
) {
  localStorage.clear();
  const dir = mkdtempSync(join(tmpdir(), "vulture-app-int-"));
  const cfg = {
    port: 4099,
    token: TOKEN,
    shellCallbackUrl: "http://127.0.0.1:4199",
    shellPid: process.pid,
    profileDir: dir,
  };
  const app = buildServer(cfg);

  // Replace global fetch with a proxy that routes into the in-process Hono
  // server. Save the previous fetch so we can restore it after.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    opts.onRequest?.(path, init);
    const res = await app.request(path, init as RequestInit);
    opts.onResponse?.(path, init);
    return res;
  }) as typeof fetch;

  return {
    app,
    dir,
    cleanup: () => {
      globalThis.fetch = realFetch;
      localStorage.clear();
      rmSync(dir, { recursive: true });
    },
  };
}

async function authedJson<T>(app: ReturnType<typeof buildServer>, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  headers.set("X-Request-Id", crypto.randomUUID());
  if (init.method === "POST") {
    headers.set("Idempotency-Key", crypto.randomUUID());
    headers.set("Content-Type", "application/json");
  }
  const res = await app.request(path, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

describe("App integration", () => {
  test("send message → assistant message appears (stub LLM, no API key)", async () => {
    const { cleanup } = setup();

    render(<App />);

    // Wait for the bootstrap effect (loads profile + agents + auth) — the
    // sidebar shows "Local Work Agent" in the agent select once the runtime
    // descriptor resolves and agents are fetched. We look for the agent name
    // which only appears after the bootstrap useEffect completes.
    await waitFor(
      () => {
        expect(screen.getByText("Local Work Agent")).toBeDefined();
      },
      { timeout: 5000 },
    );

    // Find the textarea and type a message
    const textarea = (await waitFor(
      () => screen.getByPlaceholderText(/输入问题/),
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // The user message appears immediately (POST /v1/runs returns it
    // synchronously and useMessages.append adds it to state). The assistant
    // message arrives once the stub LLM run completes — give it up to 5s.
    await waitFor(
      () => {
        expect(screen.getByText("hello")).toBeDefined();
      },
      { timeout: 5000 },
    );
    await waitFor(
      () => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("OPENAI_API_KEY not configured");
      },
      { timeout: 10_000 },
    );

    cleanup();
  }, 15_000);

  test("new conversation send does not issue active-run restore before run creation", async () => {
    let runCreateCompleted = false;
    let activeRunRestoreRequestsBeforeRunCreate = 0;
    const { cleanup } = setup({
      onRequest: (path, init) => {
        if (
          init?.method === "GET" &&
          /^\/v1\/conversations\/[^/]+\/runs\?status=active$/.test(path)
        ) {
          if (!runCreateCompleted) activeRunRestoreRequestsBeforeRunCreate += 1;
        }
      },
      onResponse: (path, init) => {
        if (
          init?.method === "POST" &&
          /^\/v1\/conversations\/[^/]+\/runs$/.test(path)
        ) {
          runCreateCompleted = true;
        }
      },
    });

    render(<App />);

    await waitFor(
      () => {
        expect(screen.getByText("Local Work Agent")).toBeDefined();
      },
      { timeout: 5000 },
    );

    const textarea = (await waitFor(
      () => screen.getByPlaceholderText(/输入问题/),
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(
      () => {
        expect(screen.getByText("hello")).toBeDefined();
      },
      { timeout: 5000 },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(activeRunRestoreRequestsBeforeRunCreate).toBe(0);
    cleanup();
  }, 15_000);

  test("restores saved active conversation on remount", async () => {
    localStorage.clear();
    let restoredMessagesRequested = false;
    const { app, cleanup } = setup({
      onRequest: (path, init) => {
        if (
          init?.method === "GET" &&
          /^\/v1\/conversations\/[^/]+\/messages$/.test(path)
        ) {
          restoredMessagesRequested = true;
        }
      },
    });

    const agents = await authedJson<{ items: Array<{ id: string }> }>(app, "/v1/agents");
    const conv = await authedJson<{ id: string }>(app, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ agentId: agents.items[0].id, title: "Restored conversation" }),
    });
    writeActiveChatState({ conversationId: conv.id, runId: null });

    render(<App />);

    await waitFor(
      () => {
        expect(restoredMessagesRequested).toBe(true);
      },
      { timeout: 5000 },
    );

    cleanup();
  }, 15_000);

  test("restores saved active run and resumes SSE from persisted seq", async () => {
    let eventStreamRequested = false;
    let lastEventId: string | null = null;
    const { app, dir, cleanup } = setup({
      onRequest: (path, init) => {
        if ((init?.method ?? "GET") === "GET" && /^\/v1\/runs\/r-active\/events$/.test(path)) {
          eventStreamRequested = true;
          lastEventId = new Headers(init.headers).get("Last-Event-ID");
        }
      },
    });

    const agents = await authedJson<{ items: Array<{ id: string }> }>(app, "/v1/agents");
    const agentId = agents.items[0].id;
    const conv = await authedJson<{ id: string }>(app, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ agentId, title: "Active restored conversation" }),
    });
    const now = "2026-04-27T00:00:00.000Z";
    const db = new Database(join(dir, "data.sqlite"));
    db.query(
      "INSERT INTO messages(id, conversation_id, role, content, run_id, created_at) VALUES (?, ?, 'user', 'still running', NULL, ?)",
    ).run("m-active-trigger", conv.id, now);
    db.query(
      `INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id,
                        result_message_id, started_at, ended_at, error_json)
       VALUES ('r-active', ?, ?, 'running', 'm-active-trigger', NULL, ?, NULL, NULL)`,
    ).run(conv.id, agentId, now);
    const startedEvent = {
      type: "run.started",
      runId: "r-active",
      seq: 0,
      createdAt: now,
      agentId,
      model: "gpt-5.4",
    };
    db.query(
      "INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES ('r-active', 0, 'run.started', ?, ?)",
    ).run(JSON.stringify(startedEvent), now);
    db.close();
    writeActiveChatState({ conversationId: conv.id, runId: "r-active" });
    writeRunLastSeq("r-active", 0);

    render(<App />);

    await waitFor(
      () => {
        expect(eventStreamRequested).toBe(true);
        expect(lastEventId).toBe("0");
      },
      { timeout: 5000 },
    );

    cleanup();
  }, 15_000);

  test("clears saved active state when conversation no longer exists", async () => {
    const { cleanup } = setup();
    writeActiveChatState({ conversationId: "c-missing", runId: "r-missing" });

    render(<App />);

    await waitFor(
      () => {
        expect(readActiveChatState()).toEqual({ conversationId: null, runId: null });
      },
      { timeout: 5000 },
    );

    cleanup();
  }, 15_000);
});
