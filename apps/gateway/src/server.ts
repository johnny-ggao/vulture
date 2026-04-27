import { Hono } from "hono";
import { join } from "node:path";
import { authMiddleware, originGuard } from "./middleware/auth";
import { errorBoundary } from "./middleware/error";
import type { GatewayConfig } from "./env";
import { openDatabase } from "./persistence/sqlite";
import { applyMigrations } from "./persistence/migrate";
import { importLegacy } from "./migration/importLegacy";
import { ProfileStore } from "./domain/profileStore";
import { WorkspaceStore } from "./domain/workspaceStore";
import { AgentStore } from "./domain/agentStore";
import { ConversationStore } from "./domain/conversationStore";
import { MessageStore } from "./domain/messageStore";
import { RunStore } from "./domain/runStore";
import { profileRouter } from "./routes/profile";
import { workspacesRouter } from "./routes/workspaces";
import { agentsRouter } from "./routes/agents";
import { conversationsRouter } from "./routes/conversations";
import { runsRouter } from "./routes/runs";
import {
  assembleAgentInstructions,
  type LlmCallable,
  type LlmYield,
  type ToolCallable,
} from "@vulture/agent-runtime";
import { selectModel } from "@vulture/llm";
import { ApprovalQueue } from "./runtime/approvalQueue";
import { makeShellCallbackTools } from "./runtime/shellCallbackTools";

export function buildServer(cfg: GatewayConfig): Hono {
  const dbPath = join(cfg.profileDir, "data.sqlite");
  const db = openDatabase(dbPath);
  applyMigrations(db);

  const importResult = importLegacy({ profileDir: cfg.profileDir, db });
  if (importResult.agentsImported || importResult.workspacesImported) {
    console.log(
      `[gateway] migrated ${importResult.agentsImported} agents + ${importResult.workspacesImported} workspaces from legacy file store`,
    );
  }

  const profileStore = new ProfileStore(db);
  const workspaceStore = new WorkspaceStore(db);
  const agentStore = new AgentStore(db, cfg.profileDir);
  const conversationStore = new ConversationStore(db);
  const messageStore = new MessageStore(db);
  const runStore = new RunStore(db);

  // One-time recovery sweep on startup. Marks any queued/running run as failed.
  const swept = runStore.recoverInflightOnStartup();
  if (swept > 0) {
    console.log(`[gateway] swept ${swept} inflight runs on startup`);
  }

  // Agent-pack root for the local-work pack (only pack in Phase 3a). Move from
  // apps/desktop-shell/agent-packs/ → apps/gateway/agent-packs/ happens in
  // Task 18; this path resolves to the new location.
  const packDir = join(import.meta.dir, "..", "agent-packs");

  const approvalQueue = new ApprovalQueue();
  const cancelSignals = new Map<string, AbortController>();

  const llm: LlmCallable = makeStubLlm();
  const tools: ToolCallable = makeShellCallbackTools({
    callbackUrl: cfg.shellCallbackUrl,
    token: cfg.token,
    appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
    approvalQueue,
    cancelSignals,
  });

  const app = new Hono();
  app.use("*", errorBoundary);
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      apiVersion: "v1",
      gatewayVersion: "0.1.0",
      uptimeMs: Math.round(process.uptime() * 1000),
    }),
  );
  app.use("*", originGuard, authMiddleware(cfg.token));

  app.route("/", profileRouter(profileStore));
  app.route("/", workspacesRouter(workspaceStore));
  app.route("/", agentsRouter(agentStore));
  app.route(
    "/",
    conversationsRouter({
      conversations: conversationStore,
      messages: messageStore,
    }),
  );
  app.route(
    "/",
    runsRouter({
      conversations: conversationStore,
      messages: messageStore,
      runs: runStore,
      llm,
      tools,
      approvalQueue,
      cancelSignals,
      systemPromptForAgent: ({ id }) => {
        const agent = agentStore.get(id);
        if (!agent) return "";
        return assembleAgentInstructions({
          packDir: join(packDir, "local-work"),
          agent: {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            model: agent.model,
            reasoning: agent.reasoning,
            tools: agent.tools,
            instructions: agent.instructions,
          },
          workspace: {
            id: agent.workspace.id,
            name: agent.workspace.name,
            path: agent.workspace.path,
          },
        });
      },
      modelForAgent: ({ id }) => selectModel(agentStore.get(id)?.model ?? ""),
      workspacePathForAgent: ({ id }) => agentStore.get(id)?.workspace.path ?? "",
    }),
  );

  return app;
}

// Stub LLM for Phase 3a — echoes input back so SSE pipeline is exercisable
// end-to-end without a real OpenAI key. Replaced with @openai/agents Run in
// a later phase.
function makeStubLlm(): LlmCallable {
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    yield { kind: "text.delta", text: `[stub] received: ${input.userInput.slice(0, 40)}` };
    yield { kind: "final", text: `[stub] done` };
  };
}
