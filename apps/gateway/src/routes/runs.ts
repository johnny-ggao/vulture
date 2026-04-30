import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { AttachmentStore } from "../domain/attachmentStore";
import { ConversationContextStore } from "../domain/conversationContextStore";
import {
  PostMessageRequestSchema,
  type MessageAttachment,
} from "@vulture/protocol/src/v1/conversation";
import { ApprovalRequestSchema } from "@vulture/protocol/src/v1/approval";
import type { RunStatus } from "@vulture/protocol/src/v1/run";
import {
  requireIdempotencyKey,
  idempotencyCache,
} from "../middleware/idempotency";
import { orchestrateRun } from "../runtime/runOrchestrator";
import type { OrchestrateArgs } from "../runtime/runOrchestrator";
import type { LlmAttachment, LlmCallable, ToolCallable } from "@vulture/agent-runtime";
import type { ApprovalQueue } from "../runtime/approvalQueue";
import { VultureConversationSession } from "../runtime/conversationSession";
import {
  buildConversationSessionInputCallback,
  messageIdFromItem,
  shouldCompactConversation,
  textFromItem,
} from "../runtime/conversationContext";
import { compactConversationContext } from "../runtime/conversationCompactor";
import type { AgentInputItem, Session } from "@openai/agents";
import type { RuntimeHookRunner } from "../runtime/runtimeHooks";

export type ResumeRunResult =
  | { status: "scheduled" }
  | { status: "already_started" }
  | { status: "missing_state" };

export interface RunsDeps {
  conversations: ConversationStore;
  messages: MessageStore;
  attachments: AttachmentStore;
  runs: RunStore;
  llm: LlmCallable;
  noToolsLlm?: LlmCallable;
  tools: ToolCallable;
  approvalQueue: ApprovalQueue;
  cancelSignals: Map<string, AbortController>;
  runtimeHooks?: RuntimeHookRunner;
  contexts?: ConversationContextStore;
  resumeRun(runId: string, mode: "auto" | "manual"): ResumeRunResult;
  systemPromptForAgent(a: { id: string }): string;
  skillsPromptForAgent?: (a: { id: string }) => string;
  memoryPromptForRun?: (a: { agentId: string; input: string }) => Promise<string> | string;
  afterRunSucceeded?: Parameters<typeof orchestrateRun>[0]["afterRunSucceeded"];
  modelForAgent(a: { id: string }): string;
  workspacePathForAgent(a: { id: string }): string;
}

export interface StartConversationRunInput {
  conversationId: string;
  input: string;
  attachmentIds?: string[];
}

export interface StartConversationRunResult {
  run: ReturnType<RunStore["create"]>;
  message: ReturnType<MessageStore["append"]>;
  eventStreamUrl: string;
}

export class RunStartError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunStartError";
  }
}

interface RunEventStream {
  aborted: boolean;
  closed: boolean;
  writeSSE(message: { id?: string; event?: string; data: string }): Promise<unknown>;
}

export interface RunEventStreamOptions {
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const RUN_STATUS_FILTERS = new Set<string>([
  "queued",
  "running",
  "recoverable",
  "succeeded",
  "failed",
  "cancelled",
  "active",
]);
type RunStatusFilter = RunStatus | "active";
const compactionQueues = new Map<string, Promise<void>>();

export async function writeRunEventStream(
  deps: Pick<RunsDeps, "runs">,
  rid: string,
  lastSeq: number,
  stream: RunEventStream,
  opts: RunEventStreamOptions = {},
): Promise<void> {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  let sentSeq = lastSeq;

  const writePing = async () => {
    if (stream.aborted || stream.closed) return;
    await stream.writeSSE({ event: "ping", data: "{}" });
  };

  // Replay any events already buffered before subscription.
  const missed = deps.runs.listEventsAfter(rid, sentSeq);
  for (const ev of missed) {
    if (stream.aborted || stream.closed) return;
    await stream.writeSSE({
      id: String(ev.seq),
      event: ev.type,
      data: JSON.stringify(ev),
    });
    sentSeq = ev.seq;
  }

  const current = deps.runs.get(rid);
  const isTerminalRun =
    current?.status === "succeeded" ||
    current?.status === "failed" ||
    current?.status === "cancelled";
  if (missed.length === 0 && isTerminalRun) {
    const terminalEvent = latestTerminalEvent(deps.runs.listEventsAfter(rid, -1));
    if (terminalEvent) {
      await stream.writeSSE({
        id: String(terminalEvent.seq),
        event: terminalEvent.type,
        data: JSON.stringify(terminalEvent),
      });
    }
    return;
  }

  // If the reconnect is already caught up, flush a lightweight frame so
  // browser fetch/read loops can observe that the SSE connection recovered.
  if (missed.length === 0) {
    await writePing();
  }

  // Notification primitive: resolves whenever a new event is appended.
  // Each notify resolves the current promise and re-arms a new one so
  // rapid back-to-back events are never missed — the next loop iteration
  // will drain all of them via listEventsAfter.
  let resolveNotify: () => void = () => {};
  let notifyPromise = new Promise<void>((r) => { resolveNotify = r; });
  const unsubscribe = deps.runs.subscribe(rid, () => {
    resolveNotify();
    notifyPromise = new Promise<void>((r) => { resolveNotify = r; });
  });

  try {
    while (!stream.aborted && !stream.closed) {
      const cur = deps.runs.get(rid);
      if (!cur) break;

      const more = deps.runs.listEventsAfter(rid, sentSeq);
      for (const ev of more) {
        if (stream.aborted || stream.closed) return;
        await stream.writeSSE({
          id: String(ev.seq),
          event: ev.type,
          data: JSON.stringify(ev),
        });
        sentSeq = ev.seq;
      }

      if (cur.status === "succeeded" || cur.status === "failed" || cur.status === "cancelled") {
        break;
      }

      const waitResult = await Promise.race([
        notifyPromise.then(() => "notify" as const),
        new Promise<"heartbeat">((r) => setTimeout(() => r("heartbeat"), heartbeatMs)),
      ]);
      if (waitResult === "heartbeat") await writePing();
    }
  } finally {
    unsubscribe();
  }
}

function latestTerminalEvent(events: ReturnType<RunStore["listEventsAfter"]>) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      return event;
    }
  }
  return null;
}

export function runsRouter(deps: RunsDeps): Hono {
  const app = new Hono();

  app.post(
    "/v1/conversations/:cid/runs",
    requireIdempotencyKey,
    idempotencyCache(),
    async (c) => {
      const cid = c.req.param("cid");
      const conv = deps.conversations.get(cid);
      if (!conv) return c.json({ code: "conversation.not_found", message: cid }, 404);
      const raw = await c.req.json().catch(() => ({}));
      const parsed = PostMessageRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ code: "internal", message: parsed.error.message }, 400);
      }
      try {
        return c.json(
          await startConversationRun(deps, {
            conversationId: cid,
            input: parsed.data.input,
            attachmentIds: parsed.data.attachmentIds,
          }),
          202,
        );
      } catch (err) {
        if (err instanceof RunStartError) {
          return c.json({ code: err.code, message: err.message }, err.status as 400);
        }
        return c.json(
          { code: "internal", message: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    },
  );

  app.get("/v1/runs/:rid", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    return c.json(run);
  });

  app.get("/v1/conversations/:cid/runs", (c) => {
    const cid = c.req.param("cid");
    const conv = deps.conversations.get(cid);
    if (!conv) return c.json({ code: "conversation.not_found", message: cid }, 404);
    const status = c.req.query("status");
    if (status && !RUN_STATUS_FILTERS.has(status)) {
      return c.json({ code: "internal", message: `invalid run status filter: ${status}` }, 400);
    }
    return c.json({
      items: deps.runs.listForConversation(
        cid,
        status ? { status: status as RunStatusFilter } : {},
      ),
    });
  });

  app.get("/v1/runs/:rid/events", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    const lastSeqHeader = c.req.header("Last-Event-ID");
    const lastSeq = lastSeqHeader ? Number.parseInt(lastSeqHeader, 10) : -1;

    return streamSSE(c, async (stream) => {
      await writeRunEventStream({ runs: deps.runs }, rid, lastSeq, stream);
    });
  });

  app.post("/v1/runs/:rid/cancel", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) {
      return c.json({ code: "run.already_completed", message: run.status }, 409);
    }
    // Abort any pending approvalQueue.wait for this run; the orchestrator's
    // try/finally will clean up cancelSignals on completion.
    deps.cancelSignals.get(rid)?.abort();
    deps.runs.markCancelled(rid);
    deps.runs.appendEvent(rid, { type: "run.cancelled" });
    return c.json(deps.runs.get(rid), 202);
  });

  app.post("/v1/runs/:rid/resume", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    if (run.status !== "recoverable") {
      return c.json({ code: "run.not_recoverable", message: run.status }, 409);
    }
    const result = deps.resumeRun(rid, "manual");
    if (result.status === "already_started") {
      return c.json({ code: "run.not_recoverable", message: "already started" }, 409);
    }
    if (result.status === "missing_state") {
      return c.json(
        {
          code: "internal.recovery_state_unavailable",
          message: `recovery state unavailable for ${rid}`,
        },
        409,
      );
    }
    return c.json(deps.runs.get(rid), 202);
  });

  app.post("/v1/runs/:rid/approvals", async (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);

    const raw = await c.req.json().catch(() => ({}));
    const parsed = ApprovalRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: "internal", message: parsed.error.message }, 400);
    }

    const ok = deps.approvalQueue.resolve(parsed.data.callId, parsed.data.decision);
    if (!ok) {
      return c.json(
        { code: "internal", message: `no pending approval for callId ${parsed.data.callId}` },
        404,
      );
    }
    return c.body(null, 202);
  });

  return app;
}

export async function startConversationRun(
  deps: RunsDeps,
  input: StartConversationRunInput,
): Promise<StartConversationRunResult> {
  const conv = deps.conversations.get(input.conversationId);
  if (!conv) {
    throw new RunStartError(404, "conversation.not_found", input.conversationId);
  }

  const appendedUserMsg = deps.messages.append({
    conversationId: input.conversationId,
    role: "user",
    content: input.input,
    runId: null,
  });

  try {
    deps.attachments.linkToMessage(input.attachmentIds ?? [], appendedUserMsg.id);
  } catch (err) {
    rollbackPendingUserMessage(deps, appendedUserMsg.id);
    throw attachmentRunStartError(err);
  }

  const userMsg = deps.messages.get(appendedUserMsg.id) ?? appendedUserMsg;
  const runtimeAttachments = toRuntimeAttachments(deps.attachments, userMsg.attachments);
  const userSessionText = textWithAttachmentMetadata(input.input, userMsg.attachments);
  if (deps.contexts) {
    try {
      deps.contexts.addSessionItems(input.conversationId, [
        {
          messageId: userMsg.id,
          role: "user",
          item: messageSessionItem("user", userSessionText, userMsg.id),
        },
      ]);
    } catch (err) {
      rollbackPendingUserMessage(deps, userMsg.id);
      throw new RunStartError(
        500,
        "internal",
        `failed to persist conversation context session item: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let run: ReturnType<RunStore["create"]>;
  let contextPrompt: string | undefined;
  let session: Session | undefined;
  let sessionInputCallback: OrchestrateArgs["sessionInputCallback"];
  let afterRunSucceeded: RunsDeps["afterRunSucceeded"];
  try {
    run = deps.runs.create({
      conversationId: input.conversationId,
      agentId: conv.agentId,
      triggeredByMessageId: userMsg.id,
    });
    contextPrompt = combineContextPrompts(
      await safeMemoryPrompt(deps, { agentId: conv.agentId, input: input.input }),
      deps.skillsPromptForAgent?.({ id: conv.agentId }),
    );
    const baseSession = deps.contexts
      ? new VultureConversationSession(deps.contexts, input.conversationId)
      : undefined;
    session = baseSession
      ? new CurrentTurnSession(baseSession, {
          messageId: userMsg.id,
          userInput: input.input,
          userSessionText,
        })
      : undefined;
    sessionInputCallback = deps.contexts
      ? buildConversationSessionInputCallback({
          getContext: () => deps.contexts?.getContext(input.conversationId) ?? null,
        })
      : undefined;
    afterRunSucceeded = buildAfterRunSucceeded(deps);
  } catch (err) {
    rollbackPendingUserMessage(deps, userMsg.id);
    throw err;
  }

  // Fire-and-forget orchestrator; SSE consumers see appended events.
  orchestrateRun(
    {
      runs: deps.runs,
      messages: deps.messages,
      conversations: deps.conversations,
      llm: deps.llm,
      tools: deps.tools,
      cancelSignals: deps.cancelSignals,
      runtimeHooks: deps.runtimeHooks,
      afterRunSucceeded,
    },
    {
      runId: run.id,
      agentId: conv.agentId,
      model: deps.modelForAgent({ id: conv.agentId }),
      systemPrompt: deps.systemPromptForAgent({ id: conv.agentId }),
      contextPrompt,
      workspacePath: deps.workspacePathForAgent({ id: conv.agentId }),
      conversationId: input.conversationId,
      userInput: input.input,
      attachments: runtimeAttachments,
      session,
      sessionInputCallback,
    },
  ).catch((err) => {
    deps.runs.markFailed(run.id, {
      code: "internal",
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    run,
    message: userMsg,
    eventStreamUrl: `/v1/runs/${run.id}/events`,
  };
}

function attachmentRunStartError(cause: unknown): RunStartError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message === "attachment.not_found") {
    return new RunStartError(404, "attachment.not_found", message);
  }
  if (message === "attachment.already_used") {
    return new RunStartError(409, "attachment.already_used", message);
  }
  return new RunStartError(400, "internal", message);
}

function rollbackPendingUserMessage(
  deps: Pick<RunsDeps, "attachments" | "contexts" | "messages">,
  messageId: string,
): void {
  try {
    const message = deps.messages.get(messageId);
    if (message) {
      deps.contexts?.deleteSessionItemsForMessage(message.conversationId, messageId);
    }
    deps.attachments.unlinkFromMessage(messageId);
    deps.messages.delete(messageId);
  } catch (err) {
    console.warn(
      "[gateway] failed to rollback pending user message",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function combineContextPrompts(...parts: Array<string | undefined | null>): string | undefined {
  const joined = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  return joined.length > 0 ? `\n\n${joined}` : undefined;
}

async function safeMemoryPrompt(
  deps: Pick<RunsDeps, "memoryPromptForRun">,
  input: { agentId: string; input: string },
): Promise<string> {
  if (!deps.memoryPromptForRun) return "";
  try {
    return await deps.memoryPromptForRun(input);
  } catch {
    return "";
  }
}

function toRuntimeAttachments(
  store: AttachmentStore,
  attachments: MessageAttachment[],
): LlmAttachment[] {
  return attachments.map((attachment) => {
    const content = store.getContent(attachment.id);
    if (!content) throw new Error(`attachment content missing: ${attachment.id}`);
    return {
      id: attachment.id,
      kind: attachment.kind,
      displayName: attachment.displayName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataBase64: content.bytes.toString("base64"),
    };
  });
}

function buildAfterRunSucceeded(deps: RunsDeps): RunsDeps["afterRunSucceeded"] {
  if (!deps.contexts && !deps.afterRunSucceeded) return undefined;

  return async (input) => {
    if (deps.contexts) {
      try {
        addAssistantSessionItemIfMissing(deps.contexts, input.conversationId, {
          messageId: input.resultMessageId,
          finalText: input.finalText,
        });
        scheduleCompactionIfNeeded(deps, input);
      } catch (err) {
        console.warn(
          "[gateway] conversation context persistence failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    await deps.afterRunSucceeded?.(input);
  };
}

function addAssistantSessionItemIfMissing(
  contexts: ConversationContextStore,
  conversationId: string,
  input: { messageId: string; finalText: string },
): void {
  const existing = contexts
    .listSessionItems(conversationId)
    .some((item) =>
      item.role === "assistant" &&
      (item.messageId === input.messageId || messageIdFromItem(item.item) === input.messageId)
    );
  if (existing) return;

  contexts.addSessionItems(conversationId, [
    {
      messageId: input.messageId,
      role: "assistant",
      item: messageSessionItem("assistant", input.finalText, input.messageId),
    },
  ]);
}

function scheduleCompactionIfNeeded(
  deps: RunsDeps,
  input: {
    conversationId: string;
    agentId: string;
    model: string;
    workspacePath: string;
  },
): void {
  if (!deps.contexts || !deps.noToolsLlm) return;
  const items = deps.contexts
    .listSessionItems(input.conversationId)
    .map((item) => item.item);
  if (!shouldCompactConversation({ items })) return;

  enqueueCompaction(input.conversationId, async () => {
    const existing = deps.contexts?.getContext(input.conversationId);
    await compactConversationContext({
      conversationId: input.conversationId,
      agentId: input.agentId,
      model: input.model,
      workspacePath: input.workspacePath,
      items,
      existingSummary: existing?.summary ?? null,
      llm: deps.noToolsLlm as LlmCallable,
      upsertContext: (context) => {
        if (!deps.contexts) return;
        if (isRegressiveContextCutoff(deps.contexts, input.conversationId, context.summarizedThroughMessageId ?? null)) {
          return;
        }
        deps.contexts.upsertContext(context);
      },
    });
  }).catch((err) => {
    console.warn(
      "[gateway] conversation context compaction failed",
      err instanceof Error ? err.message : String(err),
    );
  });
}

function enqueueCompaction(conversationId: string, task: () => Promise<void>): Promise<void> {
  const previous = compactionQueues.get(conversationId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  compactionQueues.set(conversationId, next);
  void next.then(
    () => {
      if (compactionQueues.get(conversationId) === next) {
        compactionQueues.delete(conversationId);
      }
    },
    () => {
      if (compactionQueues.get(conversationId) === next) {
        compactionQueues.delete(conversationId);
      }
    },
  );
  return next;
}

function isRegressiveContextCutoff(
  contexts: ConversationContextStore,
  conversationId: string,
  nextCutoff: string | null,
): boolean {
  const existingCutoff = contexts.getContext(conversationId)?.summarizedThroughMessageId ?? null;
  if (!existingCutoff || !nextCutoff || existingCutoff === nextCutoff) return false;

  const messageIds = contexts
    .listSessionItems(conversationId)
    .map((item) => item.messageId ?? messageIdFromItem(item.item));
  const existingIndex = messageIds.lastIndexOf(existingCutoff);
  const nextIndex = messageIds.lastIndexOf(nextCutoff);
  return existingIndex >= 0 && nextIndex >= 0 && nextIndex < existingIndex;
}

function messageSessionItem(
  role: "user" | "assistant",
  text: string,
  messageId: string,
): AgentInputItem {
  return {
    type: "message",
    role,
    providerData: { messageId },
    content: [
      {
        type: role === "user" ? "input_text" : "output_text",
        text,
      },
    ],
  } as AgentInputItem;
}

function textWithAttachmentMetadata(input: string, attachments: MessageAttachment[]): string {
  if (attachments.length === 0) return input;
  const attachmentLines = attachments.map((attachment) =>
    [
      "- ",
      attachment.displayName,
      ` (id: ${attachment.id}, kind: ${attachment.kind}, mime: ${attachment.mimeType}, size: ${attachment.sizeBytes} bytes)`,
    ].join(""),
  );
  return [input, "", "Attachments:", ...attachmentLines].join("\n");
}

class CurrentTurnSession implements Session {
  constructor(
    private readonly delegate: VultureConversationSession,
    private readonly currentTurn: { messageId: string; userInput: string; userSessionText: string },
  ) {}

  getSessionId(): Promise<string> {
    return this.delegate.getSessionId();
  }

  getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.delegate.getItems(limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const filtered = items.filter((item) => this.shouldDelegateItem(item));
    if (filtered.length === 0) return;
    await this.delegate.addItems(filtered);
  }

  popItem(): Promise<AgentInputItem | undefined> {
    return this.delegate.popItem();
  }

  clearSession(): Promise<void> {
    return this.delegate.clearSession();
  }

  private shouldDelegateItem(item: AgentInputItem): boolean {
    const role = roleFromItem(item);
    if (role === "assistant") return false;
    if (role !== "user") return true;
    if (messageIdFromItem(item) === this.currentTurn.messageId) return false;

    const text = textFromItem(item).trim();
    if (text === this.currentTurn.userInput.trim()) return false;
    if (text === this.currentTurn.userSessionText.trim()) return false;
    if (text.startsWith(`${this.currentTurn.userInput.trim()}\n`)) return false;
    return true;
  }
}

function roleFromItem(item: AgentInputItem): string {
  if (typeof item === "object" && item !== null && "role" in item && typeof item.role === "string") {
    return item.role;
  }
  return "unknown";
}
