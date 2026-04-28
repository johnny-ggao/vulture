import { Hono } from "hono";
import { z } from "zod";
import type { Agent } from "@vulture/protocol/src/v1/agent";
import { AgentStore } from "../domain/agentStore";
import { MemoryStore, type Memory } from "../domain/memoryStore";
import { MemoryFileStore, memoryRoot, type MemoryChunk, type MemoryFile } from "../domain/memoryFileStore";
import type { MemorySuggestion } from "../domain/memoryFileStore";
import { requireIdempotencyKey, idempotencyCache } from "../middleware/idempotency";
import { normalizeMemoryKeywords } from "../runtime/memoryRetrieval";

export interface MemoryView {
  id: string;
  agentId: string;
  content: string;
  path?: string;
  heading?: string | null;
  startLine?: number;
  endLine?: number;
  source?: "legacy" | "file";
  createdAt: string;
  updatedAt: string;
}

export interface MemorySuggestionView {
  id: string;
  agentId: string;
  runId: string | null;
  conversationId: string | null;
  content: string;
  reason: string;
  targetPath: string;
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
  updatedAt: string;
}

export interface MemoryFileStatusView {
  path: string;
  status: "indexed" | "failed";
  indexedAt: string;
  errorMessage: string | null;
}

export interface MemoryStatusView {
  agentId: string;
  rootPath: string;
  fileCount: number;
  chunkCount: number;
  indexedAt: string | null;
  files: MemoryFileStatusView[];
}

export interface MemoriesDeps {
  agents: AgentStore;
  memories: MemoryStore;
  memoryFiles?: MemoryFileStore;
  embed?: (input: string) => Promise<number[] | null>;
}

const CreateMemorySchema = z
  .object({
    content: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  })
  .strict();

export function memoriesRouter(deps: MemoriesDeps): Hono {
  const app = new Hono();

  app.get("/v1/agents/:agentId/memories", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = deps.agents.get(agentId);
    if (!agent) {
      return c.json({ code: "agent.not_found", message: agentId }, 404);
    }
    if (deps.memoryFiles) {
      await refreshMemoryIndex(deps.memoryFiles, agent);
      return c.json({ items: deps.memoryFiles.listChunks(agentId).map(chunkToView) });
    }
    return c.json({ items: deps.memories.list(agentId).map(toView) });
  });

  app.get("/v1/agents/:agentId/memories/status", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = deps.agents.get(agentId);
    if (!agent) {
      return c.json({ code: "agent.not_found", message: agentId }, 404);
    }
    if (!deps.memoryFiles) {
      return c.json({
        agentId,
        rootPath: agent.workspace.path,
        fileCount: 0,
        chunkCount: deps.memories.list(agentId).length,
        indexedAt: null,
        files: [],
      } satisfies MemoryStatusView);
    }
    await refreshMemoryIndex(deps.memoryFiles, agent);
    return c.json(memoryStatusToView(agentId, memoryRoot(agent), deps.memoryFiles));
  });

  app.post("/v1/agents/:agentId/memories/reindex", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = deps.agents.get(agentId);
    if (!agent) {
      return c.json({ code: "agent.not_found", message: agentId }, 404);
    }
    if (!deps.memoryFiles) {
      return c.json({
        agentId,
        rootPath: agent.workspace.path,
        fileCount: 0,
        chunkCount: deps.memories.list(agentId).length,
        indexedAt: null,
        files: [],
      } satisfies MemoryStatusView);
    }
    await refreshMemoryIndex(deps.memoryFiles, agent);
    return c.json(memoryStatusToView(agentId, memoryRoot(agent), deps.memoryFiles));
  });

  app.post(
    "/v1/agents/:agentId/memories",
    requireIdempotencyKey,
    idempotencyCache(),
    async (c) => {
      const agentId = c.req.param("agentId");
      if (!deps.agents.get(agentId)) {
        return c.json({ code: "agent.not_found", message: agentId }, 404);
      }
      const agent = deps.agents.get(agentId);
      if (!agent) {
        return c.json({ code: "agent.not_found", message: agentId }, 404);
      }
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CreateMemorySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ code: "internal", message: parsed.error.message }, 400);
      }
      if (deps.memoryFiles) {
        const chunks = await deps.memoryFiles.append(agent, "MEMORY.md", parsed.data.content);
        const created = chunks.find((chunk) => chunk.content.includes(parsed.data.content)) ?? chunks[0];
        return c.json(chunkToView(created), 201);
      }
      const embedding = await safeEmbed(deps.embed, parsed.data.content);
      const memory = deps.memories.create({
        agentId,
        content: parsed.data.content,
        keywords: normalizeMemoryKeywords(parsed.data.content),
        embedding,
      });
      return c.json(toView(memory), 201);
    },
  );

  app.delete("/v1/agents/:agentId/memories/:memoryId", (c) => {
    const agentId = c.req.param("agentId");
    if (!deps.agents.get(agentId)) {
      return c.json({ code: "agent.not_found", message: agentId }, 404);
    }
    if (deps.memoryFiles?.getChunk(agentId, c.req.param("memoryId"))) {
      return c.json(
        {
          code: "memory.file_backed",
          message: "File-backed memories must be edited in Markdown.",
        },
        409,
      );
    }
    const deleted = deps.memories.delete(agentId, c.req.param("memoryId"));
    if (!deleted) {
      return c.json({ code: "memory.not_found", message: c.req.param("memoryId") }, 404);
    }
    return c.body(null, 204);
  });

  app.get("/v1/agents/:agentId/memory-suggestions", (c) => {
    const agentId = c.req.param("agentId");
    if (!deps.agents.get(agentId)) {
      return c.json({ code: "agent.not_found", message: agentId }, 404);
    }
    if (!deps.memoryFiles) return c.json({ items: [] });
    const status = c.req.query("status");
    const normalized = status === "all" || status === "accepted" || status === "dismissed"
      ? status
      : "pending";
    return c.json({ items: deps.memoryFiles.listSuggestions(agentId, normalized).map(suggestionToView) });
  });

  app.post("/v1/agents/:agentId/memory-suggestions/:suggestionId/accept", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = deps.agents.get(agentId);
    if (!agent) return c.json({ code: "agent.not_found", message: agentId }, 404);
    if (!deps.memoryFiles) {
      return c.json({ code: "memory.not_found", message: c.req.param("suggestionId") }, 404);
    }
    try {
      return c.json(suggestionToView(await deps.memoryFiles.acceptSuggestion(agent, c.req.param("suggestionId"))));
    } catch (err) {
      return c.json({
        code: "memory.not_found",
        message: err instanceof Error ? err.message : String(err),
      }, 404);
    }
  });

  app.post("/v1/agents/:agentId/memory-suggestions/:suggestionId/dismiss", (c) => {
    const agentId = c.req.param("agentId");
    if (!deps.agents.get(agentId)) {
      return c.json({ code: "agent.not_found", message: agentId }, 404);
    }
    if (!deps.memoryFiles) {
      return c.json({ code: "memory.not_found", message: c.req.param("suggestionId") }, 404);
    }
    try {
      return c.json(suggestionToView(deps.memoryFiles.dismissSuggestion(agentId, c.req.param("suggestionId"))));
    } catch (err) {
      return c.json({
        code: "memory.not_found",
        message: err instanceof Error ? err.message : String(err),
      }, 404);
    }
  });

  return app;
}

function chunkToView(memory: MemoryChunk): MemoryView {
  return {
    id: memory.id,
    agentId: memory.agentId,
    content: memory.content,
    path: memory.path,
    heading: memory.heading,
    startLine: memory.startLine,
    endLine: memory.endLine,
    source: "file",
    createdAt: memory.updatedAt,
    updatedAt: memory.updatedAt,
  };
}

function suggestionToView(suggestion: MemorySuggestion): MemorySuggestionView {
  return {
    id: suggestion.id,
    agentId: suggestion.agentId,
    runId: suggestion.runId,
    conversationId: suggestion.conversationId,
    content: suggestion.content,
    reason: suggestion.reason,
    targetPath: suggestion.targetPath,
    status: suggestion.status,
    createdAt: suggestion.createdAt,
    updatedAt: suggestion.updatedAt,
  };
}

function memoryStatusToView(
  agentId: string,
  rootPath: string,
  memoryFiles: MemoryFileStore,
): MemoryStatusView {
  const files = memoryFiles.listFiles(agentId);
  const chunks = memoryFiles.listChunks(agentId);
  return {
    agentId,
    rootPath,
    fileCount: files.length,
    chunkCount: chunks.length,
    indexedAt: latestIndexedAt(files),
    files: files.map(fileToStatusView),
  };
}

async function refreshMemoryIndex(memoryFiles: MemoryFileStore, agent: Agent): Promise<void> {
  try {
    await memoryFiles.migrateLegacy(agent);
  } catch (cause) {
    console.warn("[gateway] memory legacy migration failed", errorMessage(cause));
  }
  await memoryFiles.reindexAgent(agent);
}

function fileToStatusView(file: MemoryFile): MemoryFileStatusView {
  return {
    path: file.path,
    status: file.status,
    indexedAt: file.indexedAt,
    errorMessage: file.errorMessage,
  };
}

function latestIndexedAt(files: MemoryFile[]): string | null {
  const latest = files
    .map((file) => file.indexedAt)
    .sort()
    .at(-1);
  return latest ?? null;
}

function toView(memory: Memory): MemoryView {
  return {
    id: memory.id,
    agentId: memory.agentId,
    content: memory.content,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

async function safeEmbed(
  embed: ((input: string) => Promise<number[] | null>) | undefined,
  input: string,
): Promise<number[] | null> {
  if (!embed) return null;
  try {
    return await embed(input);
  } catch {
    return null;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
