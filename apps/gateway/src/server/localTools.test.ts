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
});
