import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { PermissionPolicyStore } from "../domain/permissionPolicyStore";
import { makePermissionPolicyHook } from "./permissionPolicyHook";
import { createRuntimeHookRunner } from "./runtimeHooks";

function freshFixtures(permissionMode: "full_access" | "policy" = "policy") {
  const dir = mkdtempSync(join(tmpdir(), "vulture-policy-hook-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const conversations = new ConversationStore(db);
  const messages = new MessageStore(db);
  const runs = new RunStore(db);
  const policies = new PermissionPolicyStore(join(dir, "policies.json"));
  const conv = conversations.create({ agentId: "a-1", title: "", permissionMode });
  const userMsg = messages.append({
    conversationId: conv.id,
    role: "user",
    content: "hi",
    runId: null,
  });
  const run = runs.create({
    conversationId: conv.id,
    agentId: "a-1",
    triggeredByMessageId: userMsg.id,
  });
  return {
    runs,
    conversations,
    policies,
    runId: run.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}

describe("permissionPolicyHook", () => {
  test("blocks a tool call that matches a deny rule", async () => {
    const fx = freshFixtures();
    try {
      fx.policies.upsert({
        scope: "global",
        toolId: "shell.exec",
        action: "deny",
        reason: "shell disabled",
      });
      const runner = createRuntimeHookRunner([
        makePermissionPolicyHook({ policies: fx.policies, runs: fx.runs, conversations: fx.conversations }),
      ]);

      const decision = await runner.runToolBeforeCall({
        runId: fx.runId,
        workspacePath: "/tmp/work",
        callId: "c-1",
        toolId: "shell.exec",
        category: "runtime",
        input: { argv: ["pwd"] },
      });

      expect(decision.blocked).toBe(true);
      expect(decision.reason).toContain("shell disabled");
    } finally {
      fx.cleanup();
    }
  });

  test("respects agent scope when matching rules", async () => {
    const fx = freshFixtures();
    try {
      fx.policies.upsert({
        scope: "agent",
        agentId: "other-agent",
        toolId: "shell.exec",
        action: "deny",
      });
      const runner = createRuntimeHookRunner([
        makePermissionPolicyHook({ policies: fx.policies, runs: fx.runs, conversations: fx.conversations }),
      ]);

      const decision = await runner.runToolBeforeCall({
        runId: fx.runId,
        workspacePath: "/tmp/work",
        callId: "c-1",
        toolId: "shell.exec",
        category: "runtime",
        input: { argv: ["pwd"] },
      });

      expect(decision.blocked).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("blocks when commandPrefix matches the tool argv", async () => {
    const fx = freshFixtures();
    try {
      fx.policies.upsert({
        scope: "global",
        commandPrefix: "rm ",
        action: "deny",
        reason: "no rm",
      });
      const runner = createRuntimeHookRunner([
        makePermissionPolicyHook({ policies: fx.policies, runs: fx.runs, conversations: fx.conversations }),
      ]);

      const decision = await runner.runToolBeforeCall({
        runId: fx.runId,
        workspacePath: "/tmp/work",
        callId: "c-2",
        toolId: "shell.exec",
        category: "runtime",
        input: { argv: ["rm", "-rf", "."] },
      });

      expect(decision.blocked).toBe(true);
      expect(decision.reason).toContain("no rm");
    } finally {
      fx.cleanup();
    }
  });

  test("allow / ask actions do not block the call", async () => {
    const fx = freshFixtures();
    try {
      fx.policies.upsert({ scope: "global", toolId: "read", action: "allow" });
      fx.policies.upsert({ scope: "global", toolId: "write", action: "ask" });
      const runner = createRuntimeHookRunner([
        makePermissionPolicyHook({ policies: fx.policies, runs: fx.runs, conversations: fx.conversations }),
      ]);

      for (const tool of ["read", "write"] as const) {
        const decision = await runner.runToolBeforeCall({
          runId: fx.runId,
          workspacePath: "/tmp/work",
          callId: `c-${tool}`,
          toolId: tool,
          category: "fs",
          input: { path: "x" },
        });
        expect(decision.blocked).toBe(false);
      }
    } finally {
      fx.cleanup();
    }
  });

  test("full access conversation bypasses deny rules", async () => {
    const fx = freshFixtures("full_access");
    try {
      fx.policies.upsert({
        scope: "global",
        toolId: "shell.exec",
        action: "deny",
        reason: "shell disabled",
      });
      const runner = createRuntimeHookRunner([
        makePermissionPolicyHook({ policies: fx.policies, runs: fx.runs, conversations: fx.conversations }),
      ]);

      const decision = await runner.runToolBeforeCall({
        runId: fx.runId,
        workspacePath: "/tmp/work",
        callId: "c-1",
        toolId: "shell.exec",
        category: "runtime",
        input: { argv: ["pwd"] },
      });

      expect(decision.blocked).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});
