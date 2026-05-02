import type { ToolCallable } from "@vulture/agent-runtime";
import type { GatewayMcpTools } from "../runtime/gatewayLocalTools";
import { makeGatewayLocalTools } from "../runtime/gatewayLocalTools";
import {
  createWebAccessService,
  searchProviderFromSettings,
  type FetchLike,
} from "../runtime/webAccess";
import { tryEmitRuntimeHook, type RuntimeHookRunner } from "../runtime/runtimeHooks";
import type { GatewayStores } from "./stores";

export interface StartConversationRunResult {
  conversationId: string;
  runId: string;
  messageId: string;
}

export interface CreateGatewayServerLocalToolsOptions {
  stores: GatewayStores;
  shellTools: ToolCallable;
  mcp: GatewayMcpTools;
  runtimeHooks: () => RuntimeHookRunner | undefined;
  fetch?: FetchLike;
  startConversationRun: (
    conversationId: string,
    input: string,
  ) => Promise<StartConversationRunResult>;
}

export function createGatewayServerLocalTools(
  opts: CreateGatewayServerLocalToolsOptions,
): ToolCallable {
  const {
    stores: {
      agentStore,
      conversationStore,
      messageStore,
      runStore,
      subagentSessionStore,
      memoryFileStore,
      webSearchSettingsStore,
    },
  } = opts;
  const fetchImpl = opts.fetch ?? fetch;

  const agentForWorkspace = (workspacePath: string) => {
    const agent = agentStore.list().find((candidate) => candidate.workspace.path === workspacePath);
    if (!agent) throw new Error(`agent not found for workspace: ${workspacePath}`);
    return agent;
  };

  return makeGatewayLocalTools({
    shellTools: opts.shellTools,
    appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
    webAccess: createWebAccessService({
      fetch: fetchImpl,
      resolveSearchProvider: ({ fetch }) => {
        const settings = webSearchSettingsStore.get();
        return searchProviderFromSettings(settings, fetch);
      },
    }),
    mcp: opts.mcp,
    sessions: {
      list: (call) => {
        const value = call.input as {
          parentConversationId?: unknown;
          parentRunId?: unknown;
          agentId?: unknown;
          limit?: unknown;
        };
        const currentRun = runStore.get(call.runId);
        const parentConversationId =
          typeof value.parentConversationId === "string"
            ? value.parentConversationId
            : typeof value.parentRunId === "string"
            ? undefined
            : currentRun?.conversationId;
        return subagentSessionStore.list({
          parentConversationId,
          parentRunId: typeof value.parentRunId === "string" ? value.parentRunId : undefined,
          agentId: typeof value.agentId === "string" ? value.agentId : undefined,
          limit: typeof value.limit === "number" ? value.limit : 20,
        });
      },
      history: (call) => {
        const value = call.input as { sessionId?: unknown; conversationId?: unknown; limit?: unknown };
        const session = typeof value.sessionId === "string"
          ? subagentSessionStore.get(value.sessionId)
          : null;
        const conversationId = session?.conversationId ??
          (typeof value.conversationId === "string" ? value.conversationId : null);
        if (!conversationId) {
          throw new Error("sessions_history requires sessionId or conversationId");
        }
        const limit = typeof value.limit === "number" ? value.limit : 50;
        const messages = messageStore.listSince({ conversationId });
        return messages.slice(-limit);
      },
      send: async (call) => {
        const value = call.input as { sessionId?: unknown; conversationId?: unknown; message?: unknown };
        const session = typeof value.sessionId === "string"
          ? subagentSessionStore.get(value.sessionId)
          : null;
        const conversationId = session?.conversationId ??
          (typeof value.conversationId === "string" ? value.conversationId : null);
        if (!conversationId || typeof value.message !== "string") {
          throw new Error("sessions_send requires sessionId or conversationId and message");
        }
        const result = await opts.startConversationRun(conversationId, value.message);
        return {
          ...result,
          session: session ? subagentSessionStore.refreshStatus(session.id) : null,
        };
      },
      spawn: async (call) => {
        const value = call.input as {
          agentId?: unknown;
          title?: unknown;
          label?: unknown;
          message?: unknown;
        };
        const parentRun = runStore.get(call.runId);
        if (!parentRun) throw new Error(`parent run not found: ${call.runId}`);
        const agentId =
          typeof value.agentId === "string" && value.agentId.length > 0
            ? value.agentId
            : "local-work-agent";
        if (!agentStore.get(agentId)) throw new Error(`agent not found: ${agentId}`);
        const title = typeof value.title === "string" ? value.title.trim() : "";
        const task = typeof value.message === "string" ? value.message.trim() : "";
        const conversation = conversationStore.create({
          agentId,
          title: title || task.slice(0, 40) || agentId,
        });
        const label = subagentLabel(value, title, agentId);
        const session = subagentSessionStore.create({
          parentConversationId: parentRun.conversationId,
          parentRunId: parentRun.id,
          agentId,
          conversationId: conversation.id,
          label,
          title,
          task,
        });
        await tryEmitRuntimeHook(
          opts.runtimeHooks(),
          "subagent.beforeSpawn",
          {
            parentRunId: parentRun.id,
            parentConversationId: parentRun.conversationId,
            agentId,
            label,
            message: task || undefined,
          },
          {
            runId: parentRun.id,
            conversationId: parentRun.conversationId,
            agentId,
          },
        );
        if (task.length > 0) {
          const run = await opts.startConversationRun(conversation.id, task);
          return {
            ...run,
            conversation,
            session: subagentSessionStore.refreshStatus(session.id),
          };
        }
        return { conversation, runId: null, session };
      },
      yield: (call) => {
        const value = call.input as { parentConversationId?: unknown; parentRunId?: unknown; limit?: unknown };
        const parentRun = runStore.get(call.runId);
        const parentRunId = typeof value.parentRunId === "string" ? value.parentRunId : call.runId;
        const parentConversationId =
          typeof value.parentConversationId === "string"
            ? value.parentConversationId
            : parentRun?.conversationId;
        const sessions = subagentSessionStore.list({
          parentConversationId,
          parentRunId,
          limit: typeof value.limit === "number" ? value.limit : 20,
        });
        const items = sessions.map((session) => ({
          ...session,
          activeRuns: runStore.listForConversation(session.conversationId, { status: "active" }),
        }));
        const active = items
          .filter((session) => session.status === "active")
          .map((session) => compactSubagentSession(session));
        const completed = items
          .filter((session) => session.status === "completed")
          .map((session) => compactSubagentSession(session));
        const failed = items
          .filter((session) => session.status === "failed" || session.status === "cancelled")
          .map((session) => compactSubagentSession(session));
        return {
          items,
          activeRuns: items.flatMap((session) => session.activeRuns),
          active,
          completed,
          failed,
        };
      },
    },
    memory: {
      search: async (call) => {
        const agent = agentForWorkspace(call.workspacePath);
        const value = call.input as { query?: unknown; limit?: unknown };
        if (typeof value.query !== "string" || value.query.trim().length === 0) {
          throw new Error("memory_search missing query");
        }
        const limit = typeof value.limit === "number" ? value.limit : 5;
        const results = await memoryFileStore.search(agent, value.query, limit);
        return {
          items: results.map((result) => ({
            id: result.memory.id,
            path: "path" in result.memory ? result.memory.path : "MEMORY.md",
            heading: "heading" in result.memory ? result.memory.heading : null,
            score: result.score,
            source: result.source,
            snippet: truncateMemorySnippet(result.memory.content),
          })),
        };
      },
      get: async (call) => {
        const agent = agentForWorkspace(call.workspacePath);
        const value = call.input as { id?: unknown; path?: unknown };
        if (typeof value.id === "string" && value.id.length > 0) {
          const chunk = memoryFileStore.getChunk(agent.id, value.id);
          if (!chunk) throw new Error(`memory chunk not found: ${value.id}`);
          return {
            id: chunk.id,
            path: chunk.path,
            heading: chunk.heading,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content,
          };
        }
        if (typeof value.path === "string" && value.path.length > 0) {
          return memoryFileStore.getFile(agent, value.path);
        }
        throw new Error("memory_get requires id or path");
      },
      append: async (call) => {
        const agent = agentForWorkspace(call.workspacePath);
        const value = call.input as { path?: unknown; content?: unknown };
        if (typeof value.path !== "string" || typeof value.content !== "string") {
          throw new Error("memory_append missing path/content");
        }
        const chunks = await memoryFileStore.append(agent, value.path, value.content);
        return {
          path: value.path,
          items: chunks.map((chunk) => ({
            id: chunk.id,
            path: chunk.path,
            heading: chunk.heading,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
          })),
        };
      },
    },
  });
}

function truncateMemorySnippet(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 240)}...`;
}

function subagentLabel(
  input: { label?: unknown; title?: unknown; message?: unknown },
  title: string,
  agentId: string,
): string {
  if (typeof input.label === "string" && input.label.trim()) return input.label.trim().slice(0, 80);
  if (title.trim()) return title.trim().slice(0, 80);
  if (typeof input.message === "string" && input.message.trim()) {
    return input.message.trim().replace(/\s+/g, " ").slice(0, 80);
  }
  return agentId;
}

function compactSubagentSession(session: {
  id: string;
  agentId: string;
  title: string | null;
  task: string | null;
  status: string;
  resultSummary: string | null;
  lastError: string | null;
  activeRuns?: unknown[];
}) {
  return {
    sessionId: session.id,
    agentId: session.agentId,
    title: session.title,
    task: session.task,
    status: session.status,
    resultSummary: session.resultSummary,
    lastError: session.lastError,
    ...(session.status === "active" ? { activeRuns: session.activeRuns ?? [] } : {}),
  };
}
