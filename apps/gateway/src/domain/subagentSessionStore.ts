import type { DB } from "../persistence/sqlite";
import type { MessageStore } from "./messageStore";
import type { RunStore } from "./runStore";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";

export type SubagentSessionStatus = "active" | "completed" | "failed" | "cancelled";

export interface SubagentSession {
  id: string;
  parentConversationId: string;
  parentRunId: string;
  agentId: string;
  conversationId: string;
  label: string;
  status: SubagentSessionStatus;
  messageCount: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface CreateSubagentSessionInput {
  parentConversationId: string;
  parentRunId: string;
  agentId: string;
  conversationId: string;
  label: string;
  status?: SubagentSessionStatus;
}

export interface ListSubagentSessionsFilter {
  parentConversationId?: string;
  parentRunId?: string;
  agentId?: string;
  limit?: number;
}

interface SubagentSessionRow {
  id: string;
  parent_conversation_id: string;
  parent_run_id: string;
  agent_id: string;
  conversation_id: string;
  label: string;
  status: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

function rowToSession(row: SubagentSessionRow): SubagentSession {
  return {
    id: row.id,
    parentConversationId: row.parent_conversation_id,
    parentRunId: row.parent_run_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    label: row.label,
    status: normalizeStatus(row.status),
    messageCount: row.message_count,
    createdAt: row.created_at as Iso8601,
    updatedAt: row.updated_at as Iso8601,
  };
}

function normalizeStatus(value: string): SubagentSessionStatus {
  if (value === "completed" || value === "failed" || value === "cancelled") return value;
  return "active";
}

function genId(): string {
  return `sub-${crypto.randomUUID()}`;
}

export class SubagentSessionStore {
  constructor(
    private readonly db: DB,
    private readonly deps: { runs: RunStore; messages: MessageStore },
  ) {}

  create(input: CreateSubagentSessionInput): SubagentSession {
    const id = genId();
    const now = nowIso8601();
    const messageCount = this.countMessages(input.conversationId);
    this.db
      .query(
        `INSERT INTO subagent_sessions(
           id, parent_conversation_id, parent_run_id, agent_id, conversation_id,
           label, status, message_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.parentConversationId,
        input.parentRunId,
        input.agentId,
        input.conversationId,
        input.label,
        input.status ?? "active",
        messageCount,
        now,
        now,
      );
    return this.get(id) as SubagentSession;
  }

  get(id: string): SubagentSession | null {
    const row = this.db
      .query("SELECT * FROM subagent_sessions WHERE id = ?")
      .get(id) as SubagentSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  getByConversationId(conversationId: string): SubagentSession | null {
    const row = this.db
      .query("SELECT * FROM subagent_sessions WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(conversationId) as SubagentSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  list(filter: ListSubagentSessionsFilter = {}): SubagentSession[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.parentConversationId) {
      clauses.push("parent_conversation_id = ?");
      params.push(filter.parentConversationId);
    }
    if (filter.parentRunId) {
      clauses.push("parent_run_id = ?");
      params.push(filter.parentRunId);
    }
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    const limit = typeof filter.limit === "number" && filter.limit > 0
      ? Math.min(Math.trunc(filter.limit), 100)
      : 50;
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM subagent_sessions ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params, limit) as SubagentSessionRow[];
    return rows.map((row) => this.refreshStatus(row.id) ?? rowToSession(row));
  }

  refreshStatus(id: string): SubagentSession | null {
    const session = this.get(id);
    if (!session) return null;
    const status = this.deriveStatus(session.conversationId);
    const messageCount = this.countMessages(session.conversationId);
    const now = nowIso8601();
    this.db
      .query(
        "UPDATE subagent_sessions SET status = ?, message_count = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, messageCount, now, id);
    return this.get(id);
  }

  private deriveStatus(conversationId: string): SubagentSessionStatus {
    const activeRuns = this.deps.runs.listForConversation(conversationId, { status: "active" });
    if (activeRuns.length > 0) return "active";

    const latest = this.deps.runs.listForConversation(conversationId)[0];
    if (!latest) return "active";
    if (latest.status === "failed") return "failed";
    if (latest.status === "cancelled") return "cancelled";
    if (latest.status === "succeeded") return "completed";
    return "active";
  }

  private countMessages(conversationId: string): number {
    return this.deps.messages.listSince({ conversationId }).length;
  }
}
