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
  title: string | null;
  task: string | null;
  status: SubagentSessionStatus;
  messageCount: number;
  resultSummary: string | null;
  resultMessageId: string | null;
  completedAt: Iso8601 | null;
  lastError: string | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface CreateSubagentSessionInput {
  parentConversationId: string;
  parentRunId: string;
  agentId: string;
  conversationId: string;
  label: string;
  title?: string | null;
  task?: string | null;
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
  title: string | null;
  task: string | null;
  status: string;
  message_count: number;
  result_summary: string | null;
  result_message_id: string | null;
  completed_at: string | null;
  last_error: string | null;
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
    title: row.title,
    task: row.task,
    status: normalizeStatus(row.status),
    messageCount: row.message_count,
    resultSummary: row.result_summary,
    resultMessageId: row.result_message_id,
    completedAt: row.completed_at as Iso8601 | null,
    lastError: row.last_error,
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

function normalizeOptionalText(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

export function summarizeSubagentResult(content: string, maxLength = 360): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

interface TerminalMetadata {
  resultSummary: string | null;
  resultMessageId: string | null;
  completedAt: Iso8601 | null;
  lastError: string | null;
}

export interface SubagentSessionStatusChange {
  session: SubagentSession;
  previousStatus: SubagentSessionStatus;
}

export interface SubagentSessionStoreDeps {
  runs: RunStore;
  messages: MessageStore;
  /**
   * Fires when refreshStatus observes a transition from "active" to a terminal
   * status (completed / failed / cancelled). Best-effort; errors are caught by
   * the caller's hook layer.
   */
  onStatusChange?: (change: SubagentSessionStatusChange) => void;
}

export class SubagentSessionStore {
  constructor(
    private readonly db: DB,
    private readonly deps: SubagentSessionStoreDeps,
  ) {}

  create(input: CreateSubagentSessionInput): SubagentSession {
    const id = genId();
    const now = nowIso8601();
    const messageCount = this.countMessages(input.conversationId);
    this.db
      .query(
        `INSERT INTO subagent_sessions(
           id, parent_conversation_id, parent_run_id, agent_id, conversation_id,
           label, title, task, status, message_count, result_summary,
           result_message_id, completed_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.parentConversationId,
        input.parentRunId,
        input.agentId,
        input.conversationId,
        input.label,
        normalizeOptionalText(input.title),
        normalizeOptionalText(input.task),
        input.status ?? "active",
        messageCount,
        null,
        null,
        null,
        null,
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

  count(filter: Omit<ListSubagentSessionsFilter, "limit"> = {}): number {
    const clauses: string[] = [];
    const params: string[] = [];
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
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const row = this.db
      .query(`SELECT COUNT(*) AS count FROM subagent_sessions ${where}`)
      .get(...params) as { count: number };
    return row.count;
  }

  refreshStatus(id: string): SubagentSession | null {
    const session = this.get(id);
    if (!session) return null;
    const status = this.deriveStatus(session.conversationId);
    const messageCount = this.countMessages(session.conversationId);
    const now = nowIso8601();
    const terminal = this.terminalMetadata(session, status, now);
    this.db
      .query(
        `UPDATE subagent_sessions
         SET status = ?, message_count = ?, result_summary = ?, result_message_id = ?,
             completed_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        messageCount,
        terminal.resultSummary,
        terminal.resultMessageId,
        terminal.completedAt,
        terminal.lastError,
        now,
        id,
      );
    const next = this.get(id);
    if (
      next &&
      session.status === "active" &&
      next.status !== "active" &&
      this.deps.onStatusChange
    ) {
      try {
        this.deps.onStatusChange({ session: next, previousStatus: session.status });
      } catch {
        // onStatusChange failures should not derail status reads.
      }
    }
    return next;
  }

  private terminalMetadata(
    session: SubagentSession,
    status: SubagentSessionStatus,
    now: Iso8601,
  ): TerminalMetadata {
    if (status === "active") {
      return {
        resultSummary: null,
        resultMessageId: null,
        completedAt: null,
        lastError: null,
      };
    }
    if (status === "completed") {
      const result = this.latestSucceededResultMessage(session.conversationId);
      return {
        resultSummary: result ? summarizeSubagentResult(result.content) : session.resultSummary,
        resultMessageId: result?.id ?? session.resultMessageId,
        completedAt: session.completedAt ?? now,
        lastError: null,
      };
    }
    return {
      resultSummary: session.resultSummary,
      resultMessageId: session.resultMessageId,
      completedAt: session.completedAt ?? now,
      lastError: this.latestRunError(session.conversationId) ?? status,
    };
  }

  private latestSucceededResultMessage(conversationId: string) {
    const latestSucceededRun = this.deps.runs
      .listForConversation(conversationId)
      .find((run) => run.status === "succeeded" && run.resultMessageId);
    if (!latestSucceededRun?.resultMessageId) return null;
    return this.deps.messages.get(latestSucceededRun.resultMessageId);
  }

  private latestRunError(conversationId: string): string | null {
    const latest = this.deps.runs.listForConversation(conversationId)[0];
    return latest?.error?.message ?? null;
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
