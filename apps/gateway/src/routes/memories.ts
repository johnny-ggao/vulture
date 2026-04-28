import { Hono } from "hono";
import { z } from "zod";
import { AgentStore } from "../domain/agentStore";
import { MemoryStore, type Memory } from "../domain/memoryStore";
import { requireIdempotencyKey, idempotencyCache } from "../middleware/idempotency";
import { normalizeMemoryKeywords } from "../runtime/memoryRetrieval";

export interface MemoryView {
  id: string;
  agentId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoriesDeps {
  agents: AgentStore;
  memories: MemoryStore;
  embed?: (input: string) => Promise<number[] | null>;
}

const CreateMemorySchema = z
  .object({
    content: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  })
  .strict();

export function memoriesRouter(deps: MemoriesDeps): Hono {
  const app = new Hono();

  app.get("/v1/agents/:agentId/memories", (c) => {
    const agentId = c.req.param("agentId");
    if (!deps.agents.get(agentId)) {
      return c.json({ code: "agent.not_found", message: agentId }, 404);
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
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CreateMemorySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ code: "internal", message: parsed.error.message }, 400);
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
    const deleted = deps.memories.delete(agentId, c.req.param("memoryId"));
    if (!deleted) {
      return c.json({ code: "memory.not_found", message: c.req.param("memoryId") }, 404);
    }
    return c.body(null, 204);
  });

  return app;
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
