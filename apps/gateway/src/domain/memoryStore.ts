import type { DB } from "../persistence/sqlite";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { brandId } from "@vulture/common";

export interface Memory {
  id: string;
  agentId: string;
  content: string;
  keywords: string[];
  embedding: number[] | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface CreateMemoryInput {
  agentId: string;
  content: string;
  keywords: string[];
  embedding: number[] | null;
}

interface MemoryRow {
  id: string;
  agent_id: string;
  content: string;
  keywords_json: string;
  embedding_json: string | null;
  created_at: string;
  updated_at: string;
}

function genId(): string {
  return brandId(`mem-${crypto.randomUUID()}`);
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseNumberArray(value: string | null): number[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    agentId: row.agent_id,
    content: row.content,
    keywords: parseStringArray(row.keywords_json),
    embedding: parseNumberArray(row.embedding_json),
    createdAt: row.created_at as Iso8601,
    updatedAt: row.updated_at as Iso8601,
  };
}

export class MemoryStore {
  constructor(private readonly db: DB) {}

  create(input: CreateMemoryInput): Memory {
    const id = genId();
    const now = nowIso8601();
    this.db
      .query(
        `INSERT INTO memories(id, agent_id, content, embedding_json, keywords_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.content,
        input.embedding ? JSON.stringify(input.embedding) : null,
        JSON.stringify(input.keywords),
        now,
        now,
      );
    return this.get(input.agentId, id) as Memory;
  }

  get(agentId: string, id: string): Memory | null {
    const row = this.db
      .query("SELECT * FROM memories WHERE agent_id = ? AND id = ?")
      .get(agentId, id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  list(agentId: string): Memory[] {
    const rows = this.db
      .query("SELECT * FROM memories WHERE agent_id = ? ORDER BY updated_at DESC, rowid DESC")
      .all(agentId) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  delete(agentId: string, id: string): boolean {
    const result = this.db
      .query("DELETE FROM memories WHERE agent_id = ? AND id = ?")
      .run(agentId, id);
    return result.changes > 0;
  }
}
