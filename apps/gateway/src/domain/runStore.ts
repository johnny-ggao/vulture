import type { DB } from "../persistence/sqlite";
import {
  RunEventSchema,
  type Run,
  type RunStatus,
  type RunEvent,
  type TokenUsage,
} from "@vulture/protocol/src/v1/run";
import type {
  RunId,
  ConversationId,
  MessageId,
} from "@vulture/protocol/src/v1/conversation";
import type { AgentId } from "@vulture/protocol/src/v1/agent";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { AppErrorSchema, type AppError } from "@vulture/protocol/src/v1/error";
import { brandId } from "@vulture/common";

/** Distributive Omit — preserves the discriminated-union shape. */
type OmitDistributive<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

type EventListener = () => void;

export type PartialRunEvent = OmitDistributive<RunEvent, "runId" | "seq" | "createdAt">;

interface RunRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  status: string;
  triggered_by_message_id: string;
  result_message_id: string | null;
  started_at: string;
  ended_at: string | null;
  error_json: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

function parseAppError(value: string | null): AppError | null {
  if (!value) return null;
  const parsed = tryParseJson(value);
  if (!parsed.ok) return null;
  const result = AppErrorSchema.safeParse(parsed.value);
  return result.success ? result.data : null;
}

function rowToRun(r: RunRow): Run {
  const usage =
    typeof r.input_tokens === "number" &&
    typeof r.output_tokens === "number" &&
    typeof r.total_tokens === "number"
      ? {
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          totalTokens: r.total_tokens,
        }
      : null;
  return {
    id: r.id as RunId,
    conversationId: r.conversation_id as ConversationId,
    agentId: r.agent_id as AgentId,
    status: r.status as RunStatus,
    triggeredByMessageId: r.triggered_by_message_id as MessageId,
    resultMessageId: (r.result_message_id ?? null) as MessageId | null,
    startedAt: r.started_at as Iso8601,
    endedAt: (r.ended_at ?? null) as Iso8601 | null,
    error: parseAppError(r.error_json),
    usage,
  };
}

function genId(): RunId {
  return brandId<RunId>(`r-${crypto.randomUUID()}`);
}

export interface CreateRunInput {
  conversationId: string;
  agentId: string;
  triggeredByMessageId: string;
}

export interface RunRecoveryMetadata {
  runId: string;
  conversationId: string;
  agentId: string;
  model: string;
  systemPrompt: string;
  contextPrompt?: string;
  userInput: string;
  workspacePath: string;
  providerKind: "codex" | "api_key" | "stub";
  updatedAt: string;
}

export interface ActiveToolRecovery {
  callId: string;
  tool: string;
  input: unknown;
  approvalToken?: string;
  idempotent?: boolean;
  startedSeq: number;
}

export interface RunRecoveryState {
  schemaVersion: number;
  sdkState: string | null;
  metadata: RunRecoveryMetadata;
  checkpointSeq: number;
  activeTool: ActiveToolRecovery | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecoveryProviderKind(value: unknown): value is RunRecoveryMetadata["providerKind"] {
  return value === "codex" || value === "api_key" || value === "stub";
}

function isRunRecoveryMetadata(value: unknown): value is RunRecoveryMetadata {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.agentId === "string" &&
    typeof value.model === "string" &&
    typeof value.systemPrompt === "string" &&
    (value.contextPrompt === undefined || typeof value.contextPrompt === "string") &&
    typeof value.userInput === "string" &&
    typeof value.workspacePath === "string" &&
    isRecoveryProviderKind(value.providerKind) &&
    typeof value.updatedAt === "string"
  );
}

function isActiveToolRecovery(value: unknown): value is ActiveToolRecovery {
  return (
    isRecord(value) &&
    typeof value.callId === "string" &&
    typeof value.tool === "string" &&
    Object.prototype.hasOwnProperty.call(value, "input") &&
    typeof value.startedSeq === "number" &&
    (value.approvalToken === undefined || typeof value.approvalToken === "string") &&
    (value.idempotent === undefined || typeof value.idempotent === "boolean")
  );
}

function tryParseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

export class RunStore {
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(private readonly db: DB) {}

  subscribe(runId: string, listener: EventListener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(runId);
    };
  }

  private notify(runId: string): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    for (const listener of [...set]) listener();
  }

  create(input: CreateRunInput): Run {
    const id = genId();
    const now = nowIso8601();
    this.db
      .query(
        `INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id,
                          result_message_id, started_at, ended_at, error_json)
         VALUES (?, ?, ?, 'queued', ?, NULL, ?, NULL, NULL)`,
      )
      .run(id, input.conversationId, input.agentId, input.triggeredByMessageId, now);
    return this.get(id) as Run;
  }

  get(id: string): Run | null {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
    return row ? rowToRun(row) : null;
  }

  listForConversation(
    conversationId: string,
    filter: { status?: RunStatus | "active" } = {},
  ): Run[] {
    const rows = filter.status === "active"
      ? this.db
        .query(
          "SELECT * FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running', 'recoverable') ORDER BY started_at DESC, rowid DESC",
        )
        .all(conversationId)
      : filter.status
      ? this.db
        .query(
          "SELECT * FROM runs WHERE conversation_id = ? AND status = ? ORDER BY started_at DESC, rowid DESC",
        )
        .all(conversationId, filter.status)
      : this.db
        .query("SELECT * FROM runs WHERE conversation_id = ? ORDER BY started_at DESC, rowid DESC")
        .all(conversationId);
    return (rows as RunRow[]).map(rowToRun);
  }

  markRunning(id: string): void {
    this.db.query("UPDATE runs SET status = 'running' WHERE id = ?").run(id);
  }

  markRecoverable(id: string): void {
    this.db.query("UPDATE runs SET status = 'recoverable' WHERE id = ?").run(id);
  }

  claimRecoverable(id: string): boolean {
    const result = this.db
      .query("UPDATE runs SET status = 'running' WHERE id = ? AND status = 'recoverable'")
      .run(id) as { changes: number };
    return result.changes === 1;
  }

  markSucceeded(id: string, resultMessageId: string): void {
    this.db
      .query(
        "UPDATE runs SET status = 'succeeded', result_message_id = ?, ended_at = ? WHERE id = ?",
      )
      .run(resultMessageId, nowIso8601(), id);
  }

  saveTokenUsage(id: string, usage: TokenUsage): void {
    this.db
      .query(
        "UPDATE runs SET input_tokens = ?, output_tokens = ?, total_tokens = ? WHERE id = ?",
      )
      .run(usage.inputTokens, usage.outputTokens, usage.totalTokens, id);
  }

  markFailed(id: string, error: AppError): void {
    this.db
      .query(
        "UPDATE runs SET status = 'failed', error_json = ?, ended_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(error), nowIso8601(), id);
  }

  markCancelled(id: string): void {
    this.db
      .query("UPDATE runs SET status = 'cancelled', ended_at = ? WHERE id = ?")
      .run(nowIso8601(), id);
  }

  /** Mark all queued/running runs as failed; called once on gateway startup. */
  recoverInflightOnStartup(): number {
    const error: AppError = {
      code: "internal.gateway_restarted",
      message: "gateway restarted while this run was in flight",
    };
    const result = this.db
      .query(
        "UPDATE runs SET status = 'failed', error_json = ?, ended_at = ? WHERE status IN ('queued', 'running')",
      )
      .run(JSON.stringify(error), nowIso8601()) as { changes: number };
    return result.changes;
  }

  listInflight(): Run[] {
    const rows = this.db
      .query(
        "SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY started_at ASC, rowid ASC",
      )
      .all() as RunRow[];
    return rows.map(rowToRun);
  }

  saveRecoveryState(runId: string, state: RunRecoveryState): void {
    this.db
      .query(
        `INSERT INTO run_recovery_state(
           run_id, schema_version, sdk_state, metadata_json, checkpoint_seq, active_tool_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           sdk_state = excluded.sdk_state,
           metadata_json = excluded.metadata_json,
           checkpoint_seq = excluded.checkpoint_seq,
           active_tool_json = excluded.active_tool_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        runId,
        state.schemaVersion,
        state.sdkState,
        JSON.stringify(state.metadata),
        state.checkpointSeq,
        state.activeTool ? JSON.stringify(state.activeTool) : null,
        nowIso8601(),
      );
  }

  getRecoveryState(runId: string): RunRecoveryState | null {
    const row = this.db
      .query("SELECT * FROM run_recovery_state WHERE run_id = ?")
      .get(runId) as
      | {
          schema_version: number;
          sdk_state: string | null;
          metadata_json: string;
          checkpoint_seq: number;
          active_tool_json: string | null;
        }
      | undefined;
    if (!row) return null;
    if (
      typeof row.schema_version !== "number" ||
      (row.sdk_state !== null && typeof row.sdk_state !== "string") ||
      typeof row.checkpoint_seq !== "number"
    ) {
      return null;
    }
    const metadataJson = tryParseJson(row.metadata_json);
    if (!metadataJson.ok || !isRunRecoveryMetadata(metadataJson.value)) return null;
    let activeTool: ActiveToolRecovery | null = null;
    if (row.active_tool_json !== null) {
      const activeToolJson = tryParseJson(row.active_tool_json);
      if (!activeToolJson.ok || !isActiveToolRecovery(activeToolJson.value)) return null;
      activeTool = activeToolJson.value;
    }
    return {
      schemaVersion: row.schema_version,
      sdkState: row.sdk_state,
      metadata: metadataJson.value,
      checkpointSeq: row.checkpoint_seq,
      activeTool,
    };
  }

  clearRecoveryState(runId: string): void {
    this.db.query("DELETE FROM run_recovery_state WHERE run_id = ?").run(runId);
  }

  appendEvent(runId: string, partial: PartialRunEvent): RunEvent {
    const seq = this.nextSeq(runId);
    const now = nowIso8601();
    const event = { ...partial, runId, seq, createdAt: now } as RunEvent;
    this.db
      .query(
        "INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, seq, event.type, JSON.stringify(event), now);
    this.notify(runId);
    return event;
  }

  listEventsAfter(runId: string, afterSeq: number): RunEvent[] {
    const rows = this.db
      .query(
        "SELECT payload_json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(runId, afterSeq) as { payload_json: string }[];
    const events: RunEvent[] = [];
    for (const row of rows) {
      const parsed = tryParseJson(row.payload_json);
      if (!parsed.ok) continue;
      const event = RunEventSchema.safeParse(parsed.value);
      if (event.success) events.push(event.data);
    }
    return events;
  }

  latestSeq(runId: string): number {
    const row = this.db
      .query("SELECT MAX(seq) AS s FROM run_events WHERE run_id = ?")
      .get(runId) as { s: number | null };
    return row.s ?? -1;
  }

  hasTerminalToolEvent(runId: string, callId: string): boolean {
    const row = this.db
      .query(
        "SELECT 1 FROM run_events WHERE run_id = ? AND type IN ('tool.completed', 'tool.failed') AND json_valid(payload_json) AND json_extract(payload_json, '$.callId') = ? LIMIT 1",
      )
      .get(runId, callId);
    return Boolean(row);
  }

  private nextSeq(runId: string): number {
    const row = this.db
      .query("SELECT MAX(seq) AS s FROM run_events WHERE run_id = ?")
      .get(runId) as { s: number | null };
    return (row.s ?? -1) + 1;
  }
}
