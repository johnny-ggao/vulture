import { describe, expect, test, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

let tauriProfiles = [
  { id: "default", name: "Default", activeAgentId: "local-work-agent" },
];
let activeTauriProfileId = "default";
let createProfileServer: ((profile: { id: string; name: string; activeAgentId: string }) => void) | null = null;

function resetTauriProfiles() {
  tauriProfiles = [
    { id: "default", name: "Default", activeAgentId: "local-work-agent" },
  ];
  activeTauriProfileId = "default";
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_runtime_info") return FAKE_RUNTIME;
    if (cmd === "list_profiles") {
      return {
        profiles: tauriProfiles,
        activeProfileId: activeTauriProfileId,
      };
    }
    if (cmd === "create_profile") {
      const request = args?.request as { name: string };
      const id = request.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const profile = { id, name: request.name.trim(), activeAgentId: "local-work-agent" };
      tauriProfiles = [...tauriProfiles, profile];
      createProfileServer?.(profile);
      return profile;
    }
    if (cmd === "switch_profile") {
      const request = args?.request as { profileId: string };
      activeTauriProfileId = request.profileId;
      return tauriProfiles.find((profile) => profile.id === request.profileId);
    }
    if (cmd === "get_auth_status") {
      return {
        active: "none",
        codex: { state: "not_signed_in" },
        apiKey: { state: "not_set" },
      };
    }
    if (cmd === "get_browser_status") {
      return {
        enabled: false,
        paired: false,
        pairingToken: null,
        relayPort: null,
      };
    }
    if (cmd === "start_browser_pairing") {
      return {
        enabled: true,
        paired: false,
        pairingToken: "pair-token",
        relayPort: 4199,
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
  resetTauriProfiles();
  const dir = mkdtempSync(join(tmpdir(), "vulture-app-int-"));
  const cfg = {
    port: 4099,
    token: TOKEN,
    shellCallbackUrl: "http://127.0.0.1:4199",
    shellPid: process.pid,
    profileDir: dir,
  };
  const app = buildServer(cfg);
  const profileApps = new Map<string, ReturnType<typeof buildServer>>([["default", app]]);
  const profileDirs = [dir];
  createProfileServer = (profile) => {
    const profileDir = mkdtempSync(join(tmpdir(), `vulture-app-int-${profile.id}-`));
    profileDirs.push(profileDir);
    writeFileSync(
      join(profileDir, "profile.json"),
      JSON.stringify({
        id: profile.id,
        name: profile.name,
        openai_secret_ref: `vulture:profile:${profile.id}:openai`,
        active_agent_id: profile.activeAgentId,
      }),
    );
    profileApps.set(profile.id, buildServer({ ...cfg, profileDir }));
  };

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
    const activeApp = profileApps.get(activeTauriProfileId) ?? app;
    const res = await activeApp.request(path, init as RequestInit);
    opts.onResponse?.(path, init);
    return res;
  }) as typeof fetch;

  return {
    app,
    dir,
    cleanup: () => {
      globalThis.fetch = realFetch;
      createProfileServer = null;
      localStorage.clear();
      for (const profileDir of profileDirs) rmSync(profileDir, { recursive: true });
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
    let conversationListRequests = 0;
    const { cleanup } = setup({
      onRequest: (path, init) => {
        if ((init?.method ?? "GET") === "GET" && path === "/v1/conversations") {
          conversationListRequests += 1;
        }
      },
    });

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
    await waitFor(
      () => {
        expect(conversationListRequests).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5000 },
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

  test("sidebar chat button starts a new conversation before the next send", async () => {
    let conversationCreates = 0;
    const { cleanup } = setup({
      onResponse: (path, init) => {
        if (init?.method === "POST" && path === "/v1/conversations") {
          conversationCreates += 1;
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
    fireEvent.change(textarea, { target: { value: "first chat" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(
      () => {
        expect(screen.getByText("first chat")).toBeDefined();
      },
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "对话" }));

    await waitFor(() => {
      expect(screen.queryByText("first chat")).toBeNull();
    });

    const nextTextarea = screen.getByPlaceholderText(/输入问题/) as HTMLTextAreaElement;
    fireEvent.change(nextTextarea, { target: { value: "second chat" } });
    fireEvent.keyDown(nextTextarea, { key: "Enter", shiftKey: false });

    await waitFor(
      () => {
        expect(screen.getByText("second chat")).toBeDefined();
        expect(conversationCreates).toBe(2);
      },
      { timeout: 5000 },
    );

    cleanup();
  }, 15_000);

  test("settings can create and switch to a new profile", async () => {
    const { cleanup } = setup();

    render(<App />);

    await waitFor(
      () => {
        expect(screen.getByText("Local Work Agent")).toBeDefined();
      },
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("Profiles")).toBeDefined();
    });

    const input = screen.getByPlaceholderText("Profile name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: "新建并切换" }));

    await waitFor(
      () => {
        expect(document.body.textContent ?? "").toContain("profile:Work");
      },
      { timeout: 5000 },
    );

    cleanup();
  }, 15_000);

  test("can send a message after creating and switching profile", async () => {
    const { cleanup } = setup();

    render(<App />);

    await waitFor(
      () => {
        expect(screen.getByText("Local Work Agent")).toBeDefined();
      },
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const input = (await waitFor(
      () => screen.getByPlaceholderText("Profile name"),
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: "新建并切换" }));

    await waitFor(
      () => {
        expect(document.body.textContent ?? "").toContain("profile:Work");
        expect(screen.getByDisplayValue("Local Work Agent")).toBeDefined();
      },
      { timeout: 5000 },
    );

    const textarea = screen.getByPlaceholderText(/输入问题/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "work hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(
      () => {
        expect(screen.getByText("work hello")).toBeDefined();
      },
      { timeout: 5000 },
    );
    await waitFor(
      () => {
        expect(document.body.textContent ?? "").toContain("OPENAI_API_KEY not configured");
      },
      { timeout: 10_000 },
    );

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

  test("keeps completed tool blocks visible after the assistant message is persisted", async () => {
    const { app, dir, cleanup } = setup();

    const agents = await authedJson<{ items: Array<{ id: string }> }>(app, "/v1/agents");
    const agentId = agents.items[0].id;
    const conv = await authedJson<{ id: string }>(app, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ agentId, title: "Tool transcript" }),
    });
    const now = "2026-04-27T00:00:00.000Z";
    const db = new Database(join(dir, "data.sqlite"));
    db.query(
      "INSERT INTO messages(id, conversation_id, role, content, run_id, created_at) VALUES (?, ?, 'user', 'read file', NULL, ?)",
    ).run("m-tool-user", conv.id, now);
    db.query(
      "INSERT INTO messages(id, conversation_id, role, content, run_id, created_at) VALUES (?, ?, 'assistant', 'done', 'r-tool', ?)",
    ).run("m-tool-assistant", conv.id, now);
    db.query(
      `INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id,
                        result_message_id, started_at, ended_at, error_json)
       VALUES ('r-tool', ?, ?, 'succeeded', 'm-tool-user', 'm-tool-assistant', ?, ?, NULL)`,
    ).run(conv.id, agentId, now, now);
    const events = [
      {
        type: "run.started",
        runId: "r-tool",
        seq: 0,
        createdAt: now,
        agentId,
        model: "gpt-5.4",
      },
      {
        type: "text.delta",
        runId: "r-tool",
        seq: 1,
        createdAt: now,
        text: "transient draft",
      },
      {
        type: "tool.planned",
        runId: "r-tool",
        seq: 2,
        createdAt: now,
        callId: "tc-1",
        tool: "read",
        input: { path: "package.json", maxBytes: null },
      },
      {
        type: "tool.completed",
        runId: "r-tool",
        seq: 3,
        createdAt: now,
        callId: "tc-1",
        output: { content: "ok" },
      },
      {
        type: "run.completed",
        runId: "r-tool",
        seq: 4,
        createdAt: now,
        resultMessageId: "m-tool-assistant",
        finalText: "done",
      },
    ];
    for (const event of events) {
      db.query(
        "INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES ('r-tool', ?, ?, ?, ?)",
      ).run(event.seq, event.type, JSON.stringify(event), now);
    }
    db.close();
    writeActiveChatState({ conversationId: conv.id, runId: "r-tool" });

    render(<App />);

    await waitFor(
      () => {
        expect(screen.getByText("read")).toBeDefined();
        expect(screen.getByText("✓ 完成")).toBeDefined();
        expect(screen.getByText("done")).toBeDefined();
      },
      { timeout: 5000 },
    );
    await waitFor(
      () => {
        expect(screen.queryByText("transient draft")).toBeNull();
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
