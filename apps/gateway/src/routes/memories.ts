import { Hono } from "hono";
import { z } from "zod";
import { AgentStore } from "../domain/agentStore";
import { MemoryStore, type Memory } from "../domain/memoryStore";
import { MemoryFileStore, type MemoryChunk } from "../domain/memoryFileStore";
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
      await deps.memoryFiles.migrateLegacy(agent);
      await deps.memoryFiles.reindexAgent(agent);
      return c.json({ items: deps.memoryFiles.listChunks(agentId).map(chunkToView) });
    }
    return c.json({ items: deps.memories.list(agentId).map(toView) });
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
