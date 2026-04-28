import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { brandId } from "@vulture/common";
import type { Agent } from "@vulture/protocol/src/v1/agent";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import type { DB } from "../persistence/sqlite";
import {
  formatMemoryToolPrompt,
  normalizeMemoryKeywords,
  retrieveRelevantMemories,
  type RetrievedMemory,
} from "../runtime/memoryRetrieval";
import type { MemoryStore } from "./memoryStore";

export interface MemoryChunk {
  id: string;
  agentId: string;
  fileId: string;
  path: string;
  heading: string | null;
  content: string;
  keywords: string[];
  embedding: number[] | null;
  startLine: number;
  endLine: number;
  updatedAt: Iso8601;
}

export interface MemoryFile {
  id: string;
  agentId: string;
  path: string;
  mtimeMs: number;
  contentHash: string;
  indexedAt: Iso8601;
  status: "indexed" | "failed";
  errorMessage: string | null;
}

export interface MemorySuggestion {
  id: string;
  agentId: string;
  runId: string | null;
  conversationId: string | null;
  content: string;
  reason: string;
  targetPath: string;
  status: "pending" | "accepted" | "dismissed";
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface CreateMemorySuggestionInput {
  agentId: string;
  runId?: string | null;
  conversationId?: string | null;
  content: string;
  reason: string;
  targetPath: string;
}

interface MemoryFileRow {
  id: string;
  agent_id: string;
  path: string;
  mtime_ms: number;
  content_hash: string;
  indexed_at: string;
  status: string;
  error_message: string | null;
}

interface MemoryChunkRow {
  id: string;
  agent_id: string;
  file_id: string;
  path: string;
  heading: string | null;
  content: string;
  keywords_json: string;
  embedding_json: string | null;
  start_line: number;
  end_line: number;
  updated_at: string;
}

interface MemorySuggestionRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  conversation_id: string | null;
  content: string;
  reason: string;
  target_path: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface LegacyMigrationRow {
  agent_id: string;
}

export interface MemoryFileStoreOptions {
  db: DB;
  legacy?: MemoryStore;
  embed?: (input: string) => Promise<number[] | null>;
}

const ROOT_MEMORY_FILE = "MEMORY.md";

export class MemoryFileStore {
  constructor(private readonly opts: MemoryFileStoreOptions) {}

  async initializeAgent(agent: Agent): Promise<void> {
    await mkdir(memoryDir(agent), { recursive: true });
    const memoryPath = absoluteMemoryPath(agent, ROOT_MEMORY_FILE);
    if (!existsSync(memoryPath)) {
      await writeFile(memoryPath, "# Memory\n\n", "utf8");
    }
  }

  async migrateLegacy(agent: Agent): Promise<void> {
    await this.initializeAgent(agent);
    if (!this.opts.legacy || this.isLegacyMigrated(agent.id)) return;
    const legacy = this.opts.legacy.list(agent.id);
    if (legacy.length > 0) {
      const lines = ["", "## Migrated Memories", ""];
      for (const memory of legacy.reverse()) {
        lines.push(`- ${memory.content}`);
      }
      lines.push("");
      await appendFile(absoluteMemoryPath(agent, ROOT_MEMORY_FILE), lines.join("\n"), "utf8");
    }
    this.opts.db
      .query("INSERT INTO memory_legacy_migrations(agent_id, migrated_at) VALUES (?, ?)")
      .run(agent.id, nowIso8601());
  }

  async reindexAgent(agent: Agent): Promise<void> {
    await this.initializeAgent(agent);
    await this.indexFile(agent, ROOT_MEMORY_FILE);
  }

  listFiles(agentId: string): MemoryFile[] {
    const rows = this.opts.db
      .query("SELECT * FROM memory_files WHERE agent_id = ? ORDER BY path ASC")
      .all(agentId) as MemoryFileRow[];
    return rows.map(rowToFile);
  }

  listChunks(agentId: string): MemoryChunk[] {
    const rows = this.opts.db
      .query("SELECT * FROM memory_chunks WHERE agent_id = ? ORDER BY path ASC, start_line ASC")
      .all(agentId) as MemoryChunkRow[];
    return rows.map(rowToChunk);
  }

  async search(agent: Agent, query: string, limit = 5): Promise<RetrievedMemory[]> {
    await this.migrateLegacy(agent);
    await this.reindexAgent(agent);
    return retrieveRelevantMemories({
      input: query,
      memories: this.listChunks(agent.id),
      topK: limit,
      embed: this.opts.embed,
    });
  }

  getChunk(agentId: string, id: string): MemoryChunk | null {
    const row = this.opts.db
      .query("SELECT * FROM memory_chunks WHERE agent_id = ? AND id = ?")
      .get(agentId, id) as MemoryChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  async getFile(agent: Agent, path: string): Promise<{ path: string; content: string }> {
    const safePath = normalizeMemoryPath(path);
    const absolutePath = absoluteMemoryPath(agent, safePath);
    assertInsideWorkspace(agent, absolutePath);
    return { path: safePath, content: await readFile(absolutePath, "utf8") };
  }

  async append(agent: Agent, path: string, content: string): Promise<MemoryChunk[]> {
    const safePath = normalizeAppendPath(path);
    const trimmed = content.trim();
    if (!trimmed) throw new Error("memory_append missing content");
    await this.initializeAgent(agent);
    const absolutePath = absoluteMemoryPath(agent, safePath);
    assertInsideWorkspace(agent, absolutePath);
    const prefix = existsSync(absolutePath) ? "\n" : "# Memory\n\n";
    await appendFile(absolutePath, `${prefix}${trimmed}\n`, "utf8");
    await this.indexFile(agent, safePath);
    return this.listChunks(agent.id).filter((chunk) => chunk.path === safePath);
  }

  async contextPrompt(agent: Agent): Promise<string> {
    await this.migrateLegacy(agent);
    await this.reindexAgent(agent);
    const summary = this.listChunks(agent.id)
      .filter((chunk) => chunk.path === ROOT_MEMORY_FILE)
      .slice(0, 5)
      .map((chunk) => chunk.content)
      .join("\n\n");
    return formatMemoryToolPrompt(summary);
  }

  createSuggestion(input: CreateMemorySuggestionInput): MemorySuggestion {
    const content = input.content.trim();
    if (!content) throw new Error("memory suggestion missing content");
    const targetPath = normalizeAppendPath(input.targetPath);
    const id = brandId(`memsug-${crypto.randomUUID()}`);
    const now = nowIso8601();
    this.opts.db
      .query(
        `INSERT INTO memory_suggestions(
          id, agent_id, run_id, conversation_id, content, reason, target_path,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.runId ?? null,
        input.conversationId ?? null,
        content,
        input.reason.trim() || "Durable memory candidate.",
        targetPath,
        now,
        now,
      );
    return this.getSuggestion(input.agentId, id) as MemorySuggestion;
  }

  listSuggestions(
    agentId: string,
    status: MemorySuggestion["status"] | "all" = "pending",
  ): MemorySuggestion[] {
    const rows =
      status === "all"
        ? (this.opts.db
            .query(
              "SELECT * FROM memory_suggestions WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC",
            )
            .all(agentId) as MemorySuggestionRow[])
        : (this.opts.db
            .query(
              "SELECT * FROM memory_suggestions WHERE agent_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC",
            )
            .all(agentId, status) as MemorySuggestionRow[]);
    return rows.map(rowToSuggestion);
  }

  getSuggestion(agentId: string, id: string): MemorySuggestion | null {
    const row = this.opts.db
      .query("SELECT * FROM memory_suggestions WHERE agent_id = ? AND id = ?")
      .get(agentId, id) as MemorySuggestionRow | undefined;
    return row ? rowToSuggestion(row) : null;
  }

  async acceptSuggestion(agent: Agent, id: string): Promise<MemorySuggestion> {
    const suggestion = this.getSuggestion(agent.id, id);
    if (!suggestion) throw new Error(`memory suggestion not found: ${id}`);
    if (suggestion.status !== "pending") return suggestion;
    await this.append(agent, suggestion.targetPath, suggestion.content);
    return this.updateSuggestionStatus(agent.id, id, "accepted");
  }

  dismissSuggestion(agentId: string, id: string): MemorySuggestion {
    return this.updateSuggestionStatus(agentId, id, "dismissed");
  }

  private updateSuggestionStatus(
    agentId: string,
    id: string,
    status: "accepted" | "dismissed",
  ): MemorySuggestion {
    this.opts.db
      .query("UPDATE memory_suggestions SET status = ?, updated_at = ? WHERE agent_id = ? AND id = ?")
      .run(status, nowIso8601(), agentId, id);
    const updated = this.getSuggestion(agentId, id);
    if (!updated) throw new Error(`memory suggestion not found: ${id}`);
    return updated;
  }

  private isLegacyMigrated(agentId: string): boolean {
    const row = this.opts.db
      .query("SELECT agent_id FROM memory_legacy_migrations WHERE agent_id = ?")
      .get(agentId) as LegacyMigrationRow | undefined;
    return Boolean(row);
  }

  private async indexFile(agent: Agent, path: string): Promise<void> {
    const safePath = normalizeMemoryPath(path);
    const absolutePath = absoluteMemoryPath(agent, safePath);
    assertInsideWorkspace(agent, absolutePath);
    const content = await readFile(absolutePath, "utf8");
    const stats = await stat(absolutePath);
    const fileHash = hash(content);
    const now = nowIso8601();
    const fileId = brandId(`memfile-${agent.id}-${fileHash.slice(0, 16)}`);
    const chunks = await this.buildChunks(agent, fileId, safePath, content, now);

    this.opts.db.transaction(() => {
      this.opts.db
        .query(
          `INSERT INTO memory_files(id, agent_id, path, mtime_ms, content_hash, indexed_at, status, error_message)
           VALUES (?, ?, ?, ?, ?, ?, 'indexed', NULL)
           ON CONFLICT(agent_id, path) DO UPDATE SET
             id = excluded.id,
             mtime_ms = excluded.mtime_ms,
             content_hash = excluded.content_hash,
             indexed_at = excluded.indexed_at,
             status = excluded.status,
             error_message = NULL`,
        )
        .run(fileId, agent.id, safePath, Math.floor(stats.mtimeMs), fileHash, now);
      this.opts.db
        .query("DELETE FROM memory_chunks WHERE agent_id = ? AND path = ?")
        .run(agent.id, safePath);
      for (const chunk of chunks) {
        this.opts.db
          .query(
            `INSERT INTO memory_chunks(
              id, agent_id, file_id, path, heading, content, keywords_json, embedding_json,
              start_line, end_line, content_hash, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.id,
            chunk.agentId,
            chunk.fileId,
            chunk.path,
            chunk.heading,
            chunk.content,
            JSON.stringify(chunk.keywords),
            chunk.embedding ? JSON.stringify(chunk.embedding) : null,
            chunk.startLine,
            chunk.endLine,
            hash(chunk.content),
            chunk.updatedAt,
          );
      }
    })();
  }

  private async buildChunks(
    agent: Agent,
    fileId: string,
    path: string,
    content: string,
    now: Iso8601,
  ): Promise<MemoryChunk[]> {
    const rawChunks = chunkMarkdown(content);
    const chunks: MemoryChunk[] = [];
    for (const raw of rawChunks) {
      const embedding = await safeEmbed(this.opts.embed, raw.content);
      chunks.push({
        id: brandId(`memchunk-${agent.id}-${hash(`${path}:${raw.startLine}:${raw.content}`).slice(0, 16)}`),
        agentId: agent.id,
        fileId,
        path,
        heading: raw.heading,
        content: raw.content,
        keywords: normalizeMemoryKeywords(raw.content),
        embedding,
        startLine: raw.startLine,
        endLine: raw.endLine,
        updatedAt: now,
      });
    }
    return chunks;
  }
}

function rowToSuggestion(row: MemorySuggestionRow): MemorySuggestion {
  const status =
    row.status === "accepted" || row.status === "dismissed" ? row.status : "pending";
  return {
    id: row.id,
    agentId: row.agent_id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    content: row.content,
    reason: row.reason,
    targetPath: row.target_path,
    status,
    createdAt: row.created_at as Iso8601,
    updatedAt: row.updated_at as Iso8601,
  };
}

export function memoryRoot(agent: Agent): string {
  return agent.workspace.path;
}

export function memoryDir(agent: Agent): string {
  return join(memoryRoot(agent), "memory");
}

function absoluteMemoryPath(agent: Agent, path: string): string {
  return resolve(memoryRoot(agent), path);
}

function assertInsideWorkspace(agent: Agent, path: string): void {
  const rel = relative(resolve(memoryRoot(agent)), resolve(path));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("memory path outside workspace");
  }
}

function normalizeMemoryPath(value: string): string {
  if (!value || isAbsolute(value) || value.includes("\0")) {
    throw new Error("invalid memory path");
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error("invalid memory path");
  }
  if (normalized !== ROOT_MEMORY_FILE && !normalized.startsWith("memory/")) {
    throw new Error("memory path must be MEMORY.md or memory/*.md");
  }
  if (!normalized.endsWith(".md")) {
    throw new Error("memory path must be markdown");
  }
  return normalized;
}

function normalizeAppendPath(value: string): string {
  const path = normalizeMemoryPath(value);
  if (path === ROOT_MEMORY_FILE) return path;
  if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) return path;
  throw new Error("memory_append path must be MEMORY.md or memory/YYYY-MM-DD.md");
}

function chunkMarkdown(content: string): Array<{
  heading: string | null;
  content: string;
  startLine: number;
  endLine: number;
}> {
  const lines = content.split(/\r?\n/);
  const chunks: Array<{ heading: string | null; lines: string[]; startLine: number }> = [];
  let current: { heading: string | null; lines: string[]; startLine: number } | null = null;
  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)?.[2]?.trim() ?? null;
    if (heading) {
      if (current) chunks.push(current);
      current = { heading, lines: heading === "Memory" ? [] : [heading], startLine: index + 1 };
      return;
    }
    if (!current) current = { heading: null, lines: [], startLine: index + 1 };
    current.lines.push(line);
  });
  if (current) chunks.push(current);

  return chunks
    .map((chunk) => {
      const text = chunk.lines.join("\n").trim();
      return {
        heading: chunk.heading,
        content: text,
        startLine: chunk.startLine,
        endLine: chunk.startLine + chunk.lines.length - 1,
      };
    })
    .filter((chunk) => chunk.content.length > 0 && chunk.content !== "Memory");
}

function rowToFile(row: MemoryFileRow): MemoryFile {
  return {
    id: row.id,
    agentId: row.agent_id,
    path: row.path,
    mtimeMs: row.mtime_ms,
    contentHash: row.content_hash,
    indexedAt: row.indexed_at as Iso8601,
    status: row.status === "failed" ? "failed" : "indexed",
    errorMessage: row.error_message,
  };
}

function rowToChunk(row: MemoryChunkRow): MemoryChunk {
  return {
    id: row.id,
    agentId: row.agent_id,
    fileId: row.file_id,
    path: row.path,
    heading: row.heading,
    content: row.content,
    keywords: parseStringArray(row.keywords_json),
    embedding: parseNumberArray(row.embedding_json),
    startLine: row.start_line,
    endLine: row.end_line,
    updatedAt: row.updated_at as Iso8601,
  };
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

async function safeEmbed(
  embed: ((input: string) => Promise<number[] | null>) | undefined,
  input: string,
): Promise<number[] | null> {
  if (!embed) return null;
  try {
    const vector = await embed(input);
    return Array.isArray(vector) && vector.every((item) => typeof item === "number")
      ? vector
      : null;
  } catch {
    return null;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
