import type { DB } from "../persistence/sqlite";
import type {
  Run,
  RunStatus,
  RunEvent,
} from "@vulture/protocol/src/v1/run";
import type {
  RunId,
  ConversationId,
  MessageId,
} from "@vulture/protocol/src/v1/conversation";
import type { AgentId } from "@vulture/protocol/src/v1/agent";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import type { AppError } from "@vulture/protocol/src/v1/error";
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
}

function rowToRun(r: RunRow): Run {
  return {
    id: r.id as RunId,
    conversationId: r.conversation_id as ConversationId,
    agentId: r.agent_id as AgentId,
    status: r.status as RunStatus,
    triggeredByMessageId: r.triggered_by_message_id as MessageId,
    resultMessageId: (r.result_message_id ?? null) as MessageId | null,
    startedAt: r.started_at as Iso8601,
    endedAt: (r.ended_at ?? null) as Iso8601 | null,
    error: r.error_json ? (JSON.parse(r.error_json) as AppError) : null,
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
          "SELECT * FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running') ORDER BY started_at DESC, rowid DESC",
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

  markSucceeded(id: string, resultMessageId: string): void {
    this.db
      .query(
        "UPDATE runs SET status = 'succeeded', result_message_id = ?, ended_at = ? WHERE id = ?",
      )
      .run(resultMessageId, nowIso8601(), id);
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
    return rows.map((r) => JSON.parse(r.payload_json) as RunEvent);
  }

  private nextSeq(runId: string): number {
    const row = this.db
      .query("SELECT MAX(seq) AS s FROM run_events WHERE run_id = ?")
      .get(runId) as { s: number | null };
    return (row.s ?? -1) + 1;
  }
}
