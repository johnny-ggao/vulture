import { describe, expect, test, mock } from "bun:test";
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

const { render, screen, fireEvent, waitFor } = await import(
  "@testing-library/react/pure"
);

function setup() {
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
    return app.request(path, init as RequestInit);
  }) as typeof fetch;

  return {
    cleanup: () => {
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true });
    },
  };
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
});
