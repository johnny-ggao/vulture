import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallable } from "@vulture/agent-runtime";
import type { GatewayConfig } from "../env";
import { createRuntimeHookRunner } from "../runtime/runtimeHooks";
import { createGatewayServerLocalTools } from "./localTools";
import { createGatewayStores } from "./stores";

const TOKEN = "x".repeat(43);

function freshCfg(): { cfg: GatewayConfig; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vulture-server-local-tools-test-"));
  const cfg: GatewayConfig = {
    port: 4099,
    token: TOKEN,
    shellCallbackUrl: "http://127.0.0.1:4199",
    shellPid: 1,
    profileDir: dir,
    privateWorkspaceHomeDir: dir,
  };
  return { cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("createGatewayServerLocalTools", () => {
  test("spawns a subagent session and emits the before-spawn hook", async () => {
    const { cfg, cleanup } = freshCfg();
    try {
      const { stores } = createGatewayStores({ cfg });
      const parentConversation = stores.conversationStore.create({
        agentId: "local-work-agent",
        title: "Parent",
      });
      const parentMessage = stores.messageStore.append({
        conversationId: parentConversation.id,
        role: "user",
        content: "start",
        runId: null,
      });
      const parentRun = stores.runStore.create({
        conversationId: parentConversation.id,
        agentId: "local-work-agent",
        triggeredByMessageId: parentMessage.id,
      });
      const hookEvents: Array<{ parentRunId: string; label: string }> = [];
      const runtimeHooks = createRuntimeHookRunner([
        {
          name: "subagent.beforeSpawn",
          handler: (event) => {
            hookEvents.push({ parentRunId: event.parentRunId, label: event.label });
          },
        },
      ]);
      const shellTools: ToolCallable = async () => {
        throw new Error("shell should not be called");
      };
      const tools = createGatewayServerLocalTools({
        stores,
        shellTools,
        mcp: {
          canHandle: () => false,
          execute: async () => undefined,
        },
        runtimeHooks: () => runtimeHooks,
        startConversationRun: async () => {
          throw new Error("startConversationRun should not be called without a message");
        },
      });

      const result = await tools({
        callId: "call-1",
        runId: parentRun.id,
        tool: "sessions_spawn",
        input: { title: "Research branch", label: "researcher" },
        workspacePath: cfg.profileDir,
        approvalToken: "approved",
      }) as { session: { parentRunId: string; label: string }; runId: string | null };

      expect(result.runId).toBeNull();
      expect(result.session.parentRunId).toBe(parentRun.id);
      expect(result.session.label).toBe("researcher");
      expect(hookEvents).toEqual([{ parentRunId: parentRun.id, label: "researcher" }]);
    } finally {
      cleanup();
    }
  });

  test("sessions_spawn stores title/task and sessions_yield groups completed results", async () => {
    const { cfg, cleanup } = freshCfg();
    try {
      const { stores } = createGatewayStores({ cfg });
      const parentConversation = stores.conversationStore.create({
        agentId: "local-work-agent",
        title: "Parent",
      });
      const parentMessage = stores.messageStore.append({
        conversationId: parentConversation.id,
        role: "user",
        content: "start",
        runId: null,
      });
      const parentRun = stores.runStore.create({
        conversationId: parentConversation.id,
        agentId: "local-work-agent",
        triggeredByMessageId: parentMessage.id,
      });
      const tools = createGatewayServerLocalTools({
        stores,
        shellTools: async () => {
          throw new Error("shell should not be called");
        },
        mcp: {
          canHandle: () => false,
          execute: async () => undefined,
        },
        runtimeHooks: () => undefined,
        startConversationRun: async (conversationId, input) => {
          const message = stores.messageStore.append({
            conversationId,
            role: "user",
            content: input,
            runId: null,
          });
          const run = stores.runStore.create({
            conversationId,
            agentId: "local-work-agent",
            triggeredByMessageId: message.id,
          });
          stores.runStore.markRunning(run.id);
          return { conversationId, messageId: message.id, runId: run.id };
        },
      });

      const spawned = await tools({
        callId: "spawn-1",
        runId: parentRun.id,
        tool: "sessions_spawn",
        input: {
          agentId: "local-work-agent",
          title: "Inspect docs",
          label: "Docs worker",
          message: "Read the docs and return the useful part.",
        },
        workspacePath: cfg.profileDir,
        approvalToken: "approved",
      }) as {
        runId: string;
        session: { id: string; title: string | null; task: string | null };
      };

      expect(spawned.session).toMatchObject({
        title: "Inspect docs",
        task: "Read the docs and return the useful part.",
      });

      await expect(
        tools({
          callId: "yield-active",
          runId: parentRun.id,
          tool: "sessions_yield",
          input: { parentRunId: parentRun.id },
          workspacePath: cfg.profileDir,
        }),
      ).resolves.toMatchObject({
        active: [
          {
            id: spawned.session.id,
            parentRunId: parentRun.id,
            agentId: "local-work-agent",
            title: "Inspect docs",
            task: "Read the docs and return the useful part.",
            status: "active",
            activeRuns: [{ id: spawned.runId, status: "running" }],
          },
        ],
        completed: [],
        failed: [],
      });

      const result = stores.messageStore.append({
        conversationId: stores.subagentSessionStore.get(spawned.session.id)!.conversationId,
        role: "assistant",
        content: "Useful part found.",
        runId: spawned.runId,
      });
      stores.runStore.markSucceeded(spawned.runId, result.id);

      await expect(
        tools({
          callId: "yield-1",
          runId: parentRun.id,
          tool: "sessions_yield",
          input: { parentRunId: parentRun.id },
          workspacePath: cfg.profileDir,
        }),
      ).resolves.toMatchObject({
        active: [],
        completed: [{ sessionId: spawned.session.id, resultSummary: "Useful part found." }],
        failed: [],
      });
    } finally {
      cleanup();
    }
  });

  test("uses current web search settings for future web_search calls", async () => {
    const { cfg, cleanup } = freshCfg();
    try {
      const { stores } = createGatewayStores({ cfg });
      const conversation = stores.conversationStore.create({ agentId: "local-work-agent" });
      const message = stores.messageStore.append({
        conversationId: conversation.id,
        role: "user",
        content: "search",
        runId: null,
      });
      const run = stores.runStore.create({
        conversationId: conversation.id,
        agentId: conversation.agentId,
        triggeredByMessageId: message.id,
      });
      const tools = createGatewayServerLocalTools({
        stores,
        shellTools: async () => {
          throw new Error("shell should not be called");
        },
        mcp: {
          canHandle: () => false,
          execute: async () => undefined,
        },
        runtimeHooks: () => undefined,
        startConversationRun: async () => {
          throw new Error("unused");
        },
        fetch: async (url) => {
          const href = String(url);
          if (href.includes("search.example.com")) {
            return Response.json({
              results: [{ title: "SearXNG", url: "https://example.com/searxng" }],
            });
          }
          return new Response(
            '<a class="result__a" href="https://example.com/duck">Duck</a>',
            { status: 200, headers: { "content-type": "text/html" } },
          );
        },
      });

      await expect(
        tools({
          callId: "web-1",
          runId: run.id,
          tool: "web_search",
          input: { query: "agent", limit: 1 },
          workspacePath: cfg.profileDir,
        }),
      ).resolves.toMatchObject({
        provider: "duckduckgo-html",
        results: [{ title: "Duck" }],
      });

      stores.webSearchSettingsStore.update({
        provider: "searxng",
        searxngBaseUrl: "https://search.example.com",
      });

      await expect(
        tools({
          callId: "web-2",
          runId: run.id,
          tool: "web_search",
          input: { query: "agent", limit: 1 },
          workspacePath: cfg.profileDir,
        }),
      ).resolves.toMatchObject({
        provider: "searxng",
        results: [{ title: "SearXNG" }],
      });
    } finally {
      cleanup();
    }
  });
});
