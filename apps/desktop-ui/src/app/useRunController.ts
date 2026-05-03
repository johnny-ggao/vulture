import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ApiClient } from "../api/client";
import type {
  ConversationDto,
  ConversationPermissionMode,
  CreateConversationRequest,
  MessageDto,
} from "../api/conversations";
import { conversationsApi } from "../api/conversations";
import { runsApi, type ApprovalDecision, type RunDto, type TokenUsageDto } from "../api/runs";
import { subagentSessionsApi, type SubagentSessionDto } from "../api/subagentSessions";
import {
  clearActiveRunId,
  readActiveChatState,
  writeActiveChatState,
} from "../chat/recoveryState";
import {
  retainedRunEventsForTerminalRun,
  visibleRunEventsForChat,
} from "../chat/visibleRunEvents";
import { useApproval } from "../hooks/useApproval";
import { useMessages } from "../hooks/useMessages";
import { useRunStream, type AnyRunEvent } from "../hooks/useRunStream";
import { uploadAttachmentsWithGatewayRestartFallback as uploadAttachmentsRetry } from "./gatewayRestartFallback";

export interface RunControllerConversations {
  create(req: CreateConversationRequest): Promise<ConversationDto>;
  refetch(): Promise<void>;
}

export interface UseRunControllerOptions {
  apiClient: ApiClient | null;
  selectedAgentId: string;
  conversations: RunControllerConversations;
  streamFetch?: typeof fetch;
  subagentSessionsPollMs?: number;
}

export function useRunController({
  apiClient,
  selectedAgentId,
  conversations,
  streamFetch,
  subagentSessionsPollMs = 2000,
}: UseRunControllerOptions) {
  const restoredChatRef = useRef(readActiveChatState());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    restoredChatRef.current.conversationId,
  );
  const [activeRunId, setActiveRunId] = useState<string | null>(
    restoredChatRef.current.runId,
  );
  const [retainedRunEvents, setRetainedRunEvents] = useState<{
    conversationId: string | null;
    events: AnyRunEvent[];
  }>({ conversationId: null, events: [] });
  const [conversationRuns, setConversationRuns] = useState<RunDto[]>([]);
  const [subagentSessions, setSubagentSessions] = useState<SubagentSessionDto[]>([]);
  const [subagentMessages, setSubagentMessages] = useState<Record<string, MessageDto[]>>({});
  const [loadingSubagentMessages, setLoadingSubagentMessages] = useState<Set<string>>(new Set());
  const [subagentApprovalSubmitting, setSubagentApprovalSubmitting] = useState<Set<string>>(new Set());
  const [runReconnectKey, setRunReconnectKey] = useState(0);
  const [resumingRun, setResumingRun] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<ConversationPermissionMode>("default");
  const [workingDirectory, setWorkingDirectoryState] = useState<string | null>(null);
  const sendingRunRef = useRef(false);

  const messages = useMessages(apiClient, activeConversationId);
  const runStream = useRunStream({
    client: apiClient,
    runId: activeRunId,
    reconnectKey: runReconnectKey,
    fetch: streamFetch,
  });
  const approvals = useApproval({
    client: apiClient,
    runId: activeRunId,
    events: runStream.events,
  });

  const visibleRunEvents = visibleRunEventsForChat({
    activeRunId,
    activeConversationId,
    streamStatus: runStream.status,
    streamEvents: runStream.events,
    retained: retainedRunEvents.events,
    retainedConversationId: retainedRunEvents.conversationId,
  });

  const messageUsages = useMemo(() => {
    const usages = new Map<string, TokenUsageDto>();
    for (const run of conversationRuns) {
      if (run.resultMessageId && run.usage) usages.set(run.id, run.usage);
    }
    return usages;
  }, [conversationRuns]);

  const refetchMessagesRef = useRef(messages.refetch);
  refetchMessagesRef.current = messages.refetch;
  const refetchConversationsRef = useRef(conversations.refetch);
  refetchConversationsRef.current = conversations.refetch;
  const refetchRunsRef = useRef<() => Promise<void>>(async () => undefined);
  const refetchSubagentSessionsRef = useRef<() => Promise<void>>(async () => undefined);
  const activeSubagentScopeRef = useRef(subagentScopeKey(activeConversationId, activeRunId));
  const previousSubagentScopeRef = useRef(activeSubagentScopeRef.current);
  const hasActiveSubagentSessions = subagentSessions.some((session) => session.status === "active");

  useEffect(() => {
    if (
      runStream.status === "succeeded" ||
      runStream.status === "failed" ||
      runStream.status === "cancelled"
    ) {
      setRetainedRunEvents({
        conversationId: activeConversationId,
        events: retainedRunEventsForTerminalRun(runStream.events),
      });
      void refetchMessagesRef.current();
      void refetchConversationsRef.current();
      void refetchRunsRef.current();
      void refetchSubagentSessionsRef.current();
      setActiveRunId(null);
      clearActiveRunId();
    }
  }, [activeConversationId, runStream.events, runStream.status]);

  useEffect(() => {
    writeActiveChatState({ conversationId: activeConversationId, runId: activeRunId });
  }, [activeConversationId, activeRunId]);

  useEffect(() => {
    if (!apiClient || !activeConversationId) return;
    let cancelled = false;
    (async () => {
      try {
        const conversation = await conversationsApi.get(apiClient, activeConversationId);
        if (!cancelled) {
          setPermissionMode(conversation.permissionMode);
          setWorkingDirectoryState(conversation.workingDirectory);
        }
      } catch {
        if (cancelled) return;
        setActiveConversationId(null);
        setActiveRunId(null);
        writeActiveChatState({ conversationId: null, runId: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient, activeConversationId]);

  useEffect(() => {
    if (!apiClient || !activeConversationId) {
      setSubagentSessions([]);
      setSubagentMessages({});
      setLoadingSubagentMessages(new Set());
      refetchSubagentSessionsRef.current = async () => undefined;
      return;
    }
    let cancelled = false;
    const refetch = async () => {
      try {
        const items = await subagentSessionsApi.list(apiClient, {
          parentConversationId: activeConversationId,
          parentRunId: activeRunId ?? undefined,
          limit: 20,
        });
        if (!cancelled) setSubagentSessions(items);
      } catch (cause) {
        console.error("Subagent session load failed", cause);
        if (!cancelled) setSubagentSessions([]);
      }
    };
    refetchSubagentSessionsRef.current = refetch;
    void refetch();
    return () => {
      cancelled = true;
    };
  }, [activeConversationId, activeRunId, apiClient]);

  useEffect(() => {
    const last = runStream.events[runStream.events.length - 1];
    if (!last || last.type !== "tool.completed") return;
    if (!isSessionsToolName(last.tool)) return;
    void refetchSubagentSessionsRef.current();
  }, [runStream.events]);

  useLayoutEffect(() => {
    const nextScope = subagentScopeKey(activeConversationId, activeRunId);
    activeSubagentScopeRef.current = nextScope;
    if (previousSubagentScopeRef.current !== nextScope) {
      setSubagentSessions([]);
      setSubagentMessages({});
      setLoadingSubagentMessages(new Set());
    }
    previousSubagentScopeRef.current = nextScope;
  }, [activeConversationId, activeRunId]);

  useEffect(() => {
    if (!apiClient || !activeConversationId || !hasActiveSubagentSessions) return;
    const intervalId = globalThis.setInterval(() => {
      void refetchSubagentSessionsRef.current();
    }, subagentSessionsPollMs);
    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [
    activeConversationId,
    apiClient,
    hasActiveSubagentSessions,
    activeRunId,
    subagentSessionsPollMs,
  ]);

  useEffect(() => {
    if (!apiClient || !activeConversationId) {
      setConversationRuns([]);
      refetchRunsRef.current = async () => undefined;
      return;
    }
    let cancelled = false;
    const refetchRuns = async () => {
      try {
        const runs = await runsApi.listForConversation(apiClient, activeConversationId);
        if (!cancelled) setConversationRuns(runs);
      } catch {
        if (!cancelled) setConversationRuns([]);
      }
    };
    refetchRunsRef.current = refetchRuns;
    void refetchRuns();
    return () => {
      cancelled = true;
    };
  }, [apiClient, activeConversationId]);

  useEffect(() => {
    if (!apiClient || !activeConversationId) return;
    if (sendingRunRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const activeRuns = await runsApi.listForConversation(apiClient, activeConversationId, {
          status: "active",
        });
        if (!cancelled) setActiveRunId(activeRuns[0]?.id ?? null);
      } catch {
        if (!cancelled) setActiveRunId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient, activeConversationId]);

  async function send(input: string, files: File[] = []): Promise<boolean> {
    if (!apiClient || !selectedAgentId || runStream.status === "recoverable" || resumingRun) {
      return false;
    }
    setSendError(null);
    setRetainedRunEvents({ conversationId: null, events: [] });
    sendingRunRef.current = true;
    try {
      let cid = activeConversationId;
      if (!cid) {
        const created = await conversations.create({
          agentId: selectedAgentId,
          title: input.slice(0, 40),
          permissionMode,
          workingDirectory,
        });
        cid = created.id;
        setPermissionMode(created.permissionMode);
        setWorkingDirectoryState(created.workingDirectory);
        setActiveConversationId(cid);
      }
      const uploaded = await uploadAttachmentsRetry(apiClient, files);
      const result = await runsApi.create(apiClient, cid, {
        input,
        attachmentIds: uploaded.map((attachment) => attachment.id),
      });
      setActiveRunId(result.run.id);
      messages.append(result.message);
      setConversationRuns((items) => [
        result.run,
        ...items.filter((run) => run.id !== result.run.id),
      ]);
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error("Send failed", cause);
      setSendError(message);
      return false;
    } finally {
      sendingRunRef.current = false;
    }
  }

  async function cancel() {
    if (!apiClient || !activeRunId) return;
    try {
      await runsApi.cancel(apiClient, activeRunId);
    } catch {
      // UI will see run.cancelled via SSE when the stream catches up.
    }
  }

  async function resume() {
    if (!apiClient || !activeRunId || resumingRun) return;
    const runId = activeRunId;
    setResumingRun(true);
    try {
      await runsApi.resume(apiClient, runId);
      setActiveRunId(runId);
      setRunReconnectKey((v) => v + 1);
    } catch (cause) {
      console.error("Run resume failed", cause);
    } finally {
      setResumingRun(false);
    }
  }

  async function loadSubagentMessages(sessionId: string): Promise<void> {
    if (!apiClient) return;
    const scopeAtRequestStart = activeSubagentScopeRef.current;
    setLoadingSubagentMessages((items) => new Set(items).add(sessionId));
    try {
      const result = await subagentSessionsApi.messages(apiClient, sessionId);
      if (scopeAtRequestStart !== activeSubagentScopeRef.current) return;
      setSubagentMessages((items) => ({ ...items, [sessionId]: result.items }));
      setSubagentSessions((items) =>
        items.map((session) => (session.id === sessionId ? result.session : session)),
      );
    } catch (cause) {
      console.error("Subagent messages load failed", cause);
    } finally {
      setLoadingSubagentMessages((items) => {
        const next = new Set(items);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function decideSubagentApproval(
    runId: string,
    callId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    if (!apiClient) return;
    setSubagentApprovalSubmitting((items) => new Set(items).add(callId));
    try {
      await runsApi.approve(apiClient, runId, { callId, decision });
      await refetchSubagentSessionsRef.current();
    } finally {
      setSubagentApprovalSubmitting((items) => {
        const next = new Set(items);
        next.delete(callId);
        return next;
      });
    }
  }

  function startNewConversation() {
    setActiveConversationId(null);
    setActiveRunId(null);
    setPermissionMode("default");
    setWorkingDirectoryState(null);
    setRetainedRunEvents({ conversationId: null, events: [] });
    writeActiveChatState({ conversationId: null, runId: null });
  }

  function selectConversation(id: string) {
    setActiveConversationId(id);
    setActiveRunId(null);
    setRetainedRunEvents({ conversationId: null, events: [] });
  }

  function clearActiveConversationIfMatches(id: string) {
    if (id !== activeConversationId) return;
    setActiveConversationId(null);
    setActiveRunId(null);
    setRetainedRunEvents({ conversationId: null, events: [] });
  }

  function resetForProfileSwitch() {
    setConversationRuns([]);
    startNewConversation();
  }

  async function changePermissionMode(next: ConversationPermissionMode) {
    setPermissionMode(next);
    if (!apiClient || !activeConversationId) return;
    try {
      const updated = await conversationsApi.update(apiClient, activeConversationId, {
        permissionMode: next,
      });
      setPermissionMode(updated.permissionMode);
      void refetchConversationsRef.current();
    } catch (cause) {
      console.error("Conversation permission mode update failed", cause);
    }
  }

  /**
   * Set or clear the per-conversation working directory. When called before
   * the first send (no activeConversationId yet), the value is held locally
   * and persisted on the implicit conversation create. Pass null to clear
   * (the conversation falls back to the agent's default workspace).
   */
  async function setWorkingDirectory(next: string | null) {
    setWorkingDirectoryState(next);
    if (!apiClient || !activeConversationId) return;
    try {
      const updated = await conversationsApi.update(apiClient, activeConversationId, {
        workingDirectory: next,
      });
      setWorkingDirectoryState(updated.workingDirectory);
      void refetchConversationsRef.current();
    } catch (cause) {
      console.error("Conversation working directory update failed", cause);
    }
  }

  return {
    activeConversationId,
    activeRunId,
    messages,
    runStream,
    approvals,
    visibleRunEvents,
    messageUsages,
    subagentSessions,
    subagentMessages,
    loadingSubagentMessages,
    subagentApprovalSubmitting,
    resumingRun,
    sendError,
    permissionMode,
    workingDirectory,
    send,
    cancel,
    resume,
    loadSubagentMessages,
    decideSubagentApproval,
    startNewConversation,
    selectConversation,
    clearActiveConversationIfMatches,
    resetForProfileSwitch,
    changePermissionMode,
    setWorkingDirectory,
  };
}

function isSessionsToolName(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("sessions_");
}

function subagentScopeKey(conversationId: string | null, runId: string | null): string {
  return `${conversationId ?? ""}:${runId ?? ""}`;
}
