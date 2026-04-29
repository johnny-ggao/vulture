import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AuthStatusView,
  BrowserRelayStatus,
  ChatGPTLoginStart,
} from "./commandCenterTypes";
import { useRuntimeDescriptor } from "./runtime/useRuntimeDescriptor";
import { createApiClient } from "./api/client";
import { agentsApi, type Agent, type AgentCoreFilesResponse, type AgentToolName, type AgentToolPreset, type ReasoningLevel } from "./api/agents";
import { profileApi } from "./api/profile";
import { runsApi, type RunDto, type TokenUsageDto } from "./api/runs";
import { conversationsApi, type ConversationDto } from "./api/conversations";
import { attachmentsApi } from "./api/attachments";
import { skillsApi, type SkillListResponse } from "./api/skills";
import { FALLBACK_TOOL_CATALOG, toolsApi, type ToolCatalogGroup } from "./api/tools";
import { memoriesApi, type Memory, type MemoryStatus } from "./api/memories";
import {
  mcpServersApi,
  type McpServer,
  type McpToolSummary,
  type SaveMcpServer,
  type UpdateMcpServer,
} from "./api/mcpServers";
import { AgentsPage, type AgentConfigPatch } from "./chat/AgentsPage";
import { SkillsPage } from "./chat/SkillsPage";
import { ChatView } from "./chat/ChatView";
import { HistoryDrawer } from "./chat/HistoryDrawer";
import { NewAgentModal } from "./chat/NewAgentModal";
import { OnboardingCard } from "./chat/OnboardingCard";
import { Toast } from "./chat/components";
import { PlaceholderPage } from "./chat/PlaceholderPage";
import { SettingsPage } from "./chat/SettingsPage";
import { Titlebar } from "./chat/Titlebar";
import { WorkbenchSidebar, type ViewKey } from "./chat/WorkbenchSidebar";
import {
  clearActiveRunId,
  readActiveChatState,
  writeActiveChatState,
} from "./chat/recoveryState";
import {
  retainedRunEventsForTerminalRun,
  visibleRunEventsForChat,
} from "./chat/visibleRunEvents";
import { useConversations } from "./hooks/useConversations";
import { useMessages } from "./hooks/useMessages";
import { useRunStream, type AnyRunEvent } from "./hooks/useRunStream";
import { useApproval } from "./hooks/useApproval";

interface ProfileView {
  id: string;
  name: string;
  activeAgentId: string;
}

interface ProfileListResponse {
  profiles: ProfileView[];
  activeProfileId: string;
}

/**
 * Starter prompts shown as clickable chips on the empty chat state.
 * Kept here (rather than a separate constants file) until copy is finalised.
 */
const DEFAULT_CHAT_SUGGESTIONS: ReadonlyArray<string> = [
  "帮我审查最近的代码改动",
  "解释这个错误日志",
  "起草一份产品方案",
  "总结这份文档",
];

/** Re-insert a soft-deleted agent at its original position by createdAt. */
function insertAgentByCreatedAt(items: Agent[], item: Agent): Agent[] {
  // De-duplicate first in case a refetch already raced us.
  const filtered = items.filter((a) => a.id !== item.id);
  const target = parseTime(item.createdAt);
  if (target === null) return [...filtered, item];
  for (let i = 0; i < filtered.length; i += 1) {
    const candidate = parseTime(filtered[i].createdAt);
    if (candidate !== null && candidate <= target) {
      return [...filtered.slice(0, i), item, ...filtered.slice(i)];
    }
  }
  return [...filtered, item];
}

function parseTime(input: string): number | null {
  const t = new Date(input).getTime();
  return Number.isNaN(t) ? null : t;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authLabel(status: AuthStatusView | null): string {
  if (!status) return "loading";
  if (status.active === "codex") {
    const email = status.codex.email ?? "";
    return `Codex(${email.split("@")[0]})`;
  }
  if (status.active === "api_key") return "API key";
  if (status.codex.state === "expired") return "Codex 已过期⚠";
  return "未认证";
}

function isMissingAttachmentRoute(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("POST /v1/attachments -> HTTP 404")
  );
}

function isMissingSkillsRoute(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("GET /v1/skills") &&
    cause.message.includes("HTTP 404")
  );
}

function isMissingToolsRoute(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("GET /v1/tools/catalog") &&
    cause.message.includes("HTTP 404")
  );
}

function isMissingMemoriesRoute(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("/memories") &&
    cause.message.includes("HTTP 404")
  );
}

function isMissingMcpRoute(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("/v1/mcp/servers") &&
    cause.message.includes("HTTP 404")
  );
}

function isGatewayRestarting(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.message.includes("HTTP 503") || cause.message.includes("Failed to fetch"))
  );
}

export function App() {
  const runtime = useRuntimeDescriptor();
  const apiClient = useMemo(
    () => (runtime.data ? createApiClient(runtime.data) : null),
    [runtime.data],
  );

  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [switchingProfileId, setSwitchingProfileId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogGroup[]>(FALLBACK_TOOL_CATALOG);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [authStatus, setAuthStatus] = useState<AuthStatusView | null>(null);
  const [browserStatus, setBrowserStatus] = useState<BrowserRelayStatus | null>(null);
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
  const [runReconnectKey, setRunReconnectKey] = useState(0);
  const [resumingRun, setResumingRun] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendingRunRef = useRef(false);
  const [view, setView] = useState<ViewKey>("chat");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    item: ConversationDto;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [pendingAgentDelete, setPendingAgentDelete] = useState<{
    item: Agent;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const conversations = useConversations(apiClient);
  const messages = useMessages(apiClient, activeConversationId);
  const runStream = useRunStream({
    client: apiClient,
    runId: activeRunId,
    reconnectKey: runReconnectKey,
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

  const refreshAuthStatus = useMemo(
    () => async () => {
      try {
        const status = await invoke<AuthStatusView>("get_auth_status");
        setAuthStatus(status);
      } catch {
        // Tauri unavailable in browser preview; default to "none"
        setAuthStatus({
          active: "none",
          codex: { state: "not_signed_in" },
          apiKey: { state: "not_set" },
        });
      }
    },
    [],
  );

  const refreshBrowserStatus = useMemo(
    () => async () => {
      try {
        setBrowserStatus(await invoke<BrowserRelayStatus>("get_browser_status"));
      } catch {
        setBrowserStatus(null);
      }
    },
    [],
  );

  const refreshProfiles = useMemo(
    () => async () => {
      try {
        const result = await invoke<ProfileListResponse>("list_profiles");
        setProfiles(result.profiles);
      } catch {
        setProfiles([{ id: "default", name: "Default", activeAgentId: "local-work-agent" }]);
      }
    },
    [],
  );

  // Bootstrap auth status once on mount (independent of gateway availability).
  useEffect(() => {
    void refreshAuthStatus();
    void refreshBrowserStatus();
    void refreshProfiles();
  }, [refreshAuthStatus, refreshBrowserStatus, refreshProfiles]);

  // When a run reaches a terminal status, refetch the conversation so the
  // assistant message persisted by the gateway appears in the chronological
  // message list (instead of only living in the transient runEvents).
  // Refetch is held in a ref so the effect only re-runs on status changes,
  // not on every render (messages object identity is unstable).
  const refetchMessagesRef = useRef(messages.refetch);
  refetchMessagesRef.current = messages.refetch;
  const refetchConversationsRef = useRef(conversations.refetch);
  refetchConversationsRef.current = conversations.refetch;
  const refetchRunsRef = useRef<() => Promise<void>>(async () => undefined);
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
        await conversationsApi.get(apiClient, activeConversationId);
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

  // Switching away aborts only the local SSE reader. When switching back,
  // reattach to any queued/running run for that conversation so the in-flight
  // reply keeps streaming instead of disappearing from the UI.
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

  async function loadGatewayState(expectedProfileId?: string): Promise<boolean> {
    if (!apiClient) return false;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const [profileResult, agentList] = await Promise.all([
          profileApi.get(apiClient),
          agentsApi.list(apiClient),
        ]);
        if (expectedProfileId && profileResult.id !== expectedProfileId) {
          throw new Error(`gateway still on profile ${profileResult.id}`);
        }
        setProfile({
          id: profileResult.id,
          name: profileResult.name,
          activeAgentId: profileResult.activeAgentId ?? "",
        });
        setAgents(agentList);
        try {
          const catalog = await toolsApi.catalog(apiClient);
          setToolCatalog(catalog.length > 0 ? catalog : FALLBACK_TOOL_CATALOG);
        } catch (catalogCause) {
          if (!isMissingToolsRoute(catalogCause)) throw catalogCause;
          setToolCatalog(FALLBACK_TOOL_CATALOG);
        }
        setSelectedAgentId(
          profileResult.activeAgentId || agentList[0]?.id || "",
        );
        void conversations.refetch();
        return true;
      } catch (cause) {
        lastError = cause;
        await delay(200);
      }
    }
    console.error("Failed to load gateway state", lastError);
    return false;
  }

  // Bootstrap profile + agents once when apiClient becomes available.
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!apiClient) return;
      await loadGatewayState();
      if (!mounted) return;
    })();
    return () => {
      mounted = false;
    };
  }, [apiClient]);

  async function handleSignInWithChatGPT() {
    try {
      await invoke<ChatGPTLoginStart>("start_chatgpt_login");
    } catch (cause) {
      console.error("ChatGPT login failed", cause);
    } finally {
      void refreshAuthStatus();
    }
  }

  async function handleSignOutCodex() {
    try {
      await invoke("sign_out_chatgpt");
    } finally {
      void refreshAuthStatus();
    }
  }

  async function handleSaveApiKey(apiKey: string) {
    try {
      await invoke("set_openai_api_key", { request: { apiKey } });
    } finally {
      void refreshAuthStatus();
    }
  }

  async function handleClearApiKey() {
    try {
      await invoke("clear_openai_api_key");
    } finally {
      void refreshAuthStatus();
    }
  }

  async function handleStartBrowserPairing() {
    try {
      setBrowserStatus(await invoke<BrowserRelayStatus>("start_browser_pairing"));
    } catch (cause) {
      console.error("Browser pairing failed", cause);
    }
  }

  async function handleSend(input: string, files: File[] = []): Promise<boolean> {
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
        });
        cid = created.id;
        setActiveConversationId(cid);
      }
      const uploaded = await uploadAttachmentsWithGatewayRestartFallback(files);
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

  async function handleCancel() {
    if (!apiClient || !activeRunId) return;
    try {
      await runsApi.cancel(apiClient, activeRunId);
    } catch {
      // ignore — UI will see run.cancelled via SSE
    }
  }

  async function uploadAttachmentsWithGatewayRestartFallback(files: File[]) {
    if (!apiClient || files.length === 0) return [];
    try {
      return await Promise.all(files.map((file) => attachmentsApi.upload(apiClient, file)));
    } catch (cause) {
      if (!isMissingAttachmentRoute(cause)) throw cause;
      await invoke("restart_gateway");
      let lastError: unknown = cause;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await delay(200);
        try {
          await apiClient.get<{ ok: boolean }>("/healthz");
        } catch (healthCause) {
          lastError = healthCause;
          continue;
        }
        try {
          return await Promise.all(files.map((file) => attachmentsApi.upload(apiClient, file)));
        } catch (retryCause) {
          lastError = retryCause;
          if (isMissingAttachmentRoute(retryCause) || isGatewayRestarting(retryCause)) {
            continue;
          }
          throw retryCause;
        }
      }
      throw lastError;
    }
  }

  async function loadSkillsWithGatewayRestartFallback(agentId: string): Promise<SkillListResponse> {
    if (!apiClient) throw new Error("API client is not ready");
    try {
      return await skillsApi.list(apiClient, agentId);
    } catch (cause) {
      if (!isMissingSkillsRoute(cause)) throw cause;
      await invoke("restart_gateway");
      let lastError: unknown = cause;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await delay(200);
        try {
          await apiClient.get<{ ok: boolean }>("/healthz");
        } catch (healthCause) {
          lastError = healthCause;
          continue;
        }
        try {
          return await skillsApi.list(apiClient, agentId);
        } catch (retryCause) {
          lastError = retryCause;
          if (isMissingSkillsRoute(retryCause) || isGatewayRestarting(retryCause)) {
            continue;
          }
          throw retryCause;
        }
      }
      throw lastError;
    }
  }

  async function withGatewayRestartForMissingRoute<T>(
    run: () => Promise<T>,
    isMissingRoute: (cause: unknown) => boolean,
  ): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      if (!isMissingRoute(cause) || !apiClient) throw cause;
      await invoke("restart_gateway");
      let lastError: unknown = cause;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await delay(200);
        try {
          await apiClient.get<{ ok: boolean }>("/healthz");
        } catch (healthCause) {
          lastError = healthCause;
          continue;
        }
        try {
          return await run();
        } catch (retryCause) {
          lastError = retryCause;
          if (isMissingRoute(retryCause) || isGatewayRestarting(retryCause)) continue;
          throw retryCause;
        }
      }
      throw lastError;
    }
  }

  async function loadMemories(agentId: string): Promise<Memory[]> {
    if (!apiClient) return [];
    return withGatewayRestartForMissingRoute(
      () => memoriesApi.list(apiClient, agentId),
      isMissingMemoriesRoute,
    );
  }

  async function loadMemoryStatus(agentId: string): Promise<MemoryStatus | null> {
    if (!apiClient) return null;
    return withGatewayRestartForMissingRoute(
      () => memoriesApi.status(apiClient, agentId),
      isMissingMemoriesRoute,
    );
  }

  async function reindexMemory(agentId: string): Promise<MemoryStatus> {
    if (!apiClient) throw new Error("API client is not ready");
    return withGatewayRestartForMissingRoute(
      () => memoriesApi.reindex(apiClient, agentId),
      isMissingMemoriesRoute,
    );
  }

  async function createMemory(agentId: string, content: string): Promise<Memory> {
    if (!apiClient) throw new Error("API client is not ready");
    return withGatewayRestartForMissingRoute(
      () => memoriesApi.create(apiClient, agentId, content),
      isMissingMemoriesRoute,
    );
  }

  async function deleteMemory(agentId: string, memoryId: string): Promise<void> {
    if (!apiClient) return;
    await withGatewayRestartForMissingRoute(
      () => memoriesApi.delete(apiClient, agentId, memoryId),
      isMissingMemoriesRoute,
    );
  }

  async function loadMcpServers(): Promise<McpServer[]> {
    if (!apiClient) return [];
    return await withGatewayRestartForMissingRoute(
      () => mcpServersApi.list(apiClient),
      isMissingMcpRoute,
    );
  }

  async function createMcpServer(input: SaveMcpServer): Promise<McpServer> {
    if (!apiClient) throw new Error("API client is not ready");
    return await withGatewayRestartForMissingRoute(
      () => mcpServersApi.create(apiClient, input),
      isMissingMcpRoute,
    );
  }

  async function updateMcpServer(id: string, patch: UpdateMcpServer): Promise<McpServer> {
    if (!apiClient) throw new Error("API client is not ready");
    return await withGatewayRestartForMissingRoute(
      () => mcpServersApi.update(apiClient, id, patch),
      isMissingMcpRoute,
    );
  }

  async function deleteMcpServer(id: string): Promise<void> {
    if (!apiClient) return;
    await withGatewayRestartForMissingRoute(
      () => mcpServersApi.delete(apiClient, id),
      isMissingMcpRoute,
    );
  }

  async function reconnectMcpServer(id: string): Promise<McpServer> {
    if (!apiClient) throw new Error("API client is not ready");
    return await withGatewayRestartForMissingRoute(
      () => mcpServersApi.reconnect(apiClient, id),
      isMissingMcpRoute,
    );
  }

  async function listMcpServerTools(id: string): Promise<McpToolSummary[]> {
    if (!apiClient) return [];
    return await withGatewayRestartForMissingRoute(
      () => mcpServersApi.tools(apiClient, id),
      isMissingMcpRoute,
    );
  }

  async function handleResume() {
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

  function handleNew() {
    setActiveConversationId(null);
    setActiveRunId(null);
    setRetainedRunEvents({ conversationId: null, events: [] });
    writeActiveChatState({ conversationId: null, runId: null });
  }

  function startNewConversation() {
    handleNew();
    setView("chat");
    setHistoryOpen(false);
  }

  async function handleSwitchProfile(profileId: string) {
    if (!apiClient || profileId === profile?.id || switchingProfileId) return;
    setSwitchingProfileId(profileId);
    try {
      const switched = await invoke<ProfileView>("switch_profile", {
        request: { profileId },
      });
      setProfile(switched);
      setAgents([]);
      setSelectedAgentId("");
      setConversationRuns([]);
      handleNew();
      setView("chat");
      await Promise.all([refreshProfiles(), refreshAuthStatus()]);
      await loadGatewayState(switched.id);
    } catch (cause) {
      console.error("Profile switch failed", cause);
    } finally {
      setSwitchingProfileId(null);
    }
  }

  async function handleCreateProfile(name: string) {
    if (!apiClient || switchingProfileId) return;
    setSwitchingProfileId("__create__");
    try {
      const created = await invoke<ProfileView>("create_profile", {
        request: { name },
      });
      setProfiles((items) => [...items, created]);
      setSwitchingProfileId(null);
      await handleSwitchProfile(created.id);
    } catch (cause) {
      console.error("Profile create failed", cause);
    } finally {
      setSwitchingProfileId(null);
    }
  }

  const onboardingCard =
    authStatus?.active === "none" ? (
      <OnboardingCard
        onSignInWithChatGPT={handleSignInWithChatGPT}
        onFocusApiKey={() => {}}
      />
    ) : null;

  const chatSuggestions = onboardingCard
    ? undefined
    : DEFAULT_CHAT_SUGGESTIONS;

  /**
   * One-tap delete: hide the row immediately, surface an undo toast for
   * 5 seconds, and only call the API when the user does NOT undo.
   * If the user navigates back to the row before commit, we restore.
   */
  function handleDeleteConversation(id: string) {
    const target = conversations.items.find((c) => c.id === id);
    if (!target) return;

    // If a previous undo window is still open, commit it now so we don't
    // pile up timers (each pending delete owns its own grace period).
    if (pendingDelete) {
      clearTimeout(pendingDelete.timer);
      void conversations.commitDelete(pendingDelete.item.id);
    }

    conversations.softDelete(id);

    // If the deleted row was the active one, drop it from the chat surface
    // so the user doesn't see stale messages from a removed conversation.
    if (id === activeConversationId) {
      setActiveConversationId(null);
      setActiveRunId(null);
      setRetainedRunEvents({ conversationId: null, events: [] });
    }

    const timer = setTimeout(() => {
      setPendingDelete(null);
      void conversations.commitDelete(id);
    }, 5000);
    setPendingDelete({ item: target, timer });
  }

  function handleUndoDelete() {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    conversations.restore(pendingDelete.item);
    setPendingDelete(null);
  }

  function handleDismissDeleteToast() {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    void conversations.commitDelete(pendingDelete.item.id);
    setPendingDelete(null);
  }

  // On unmount, clear the grace-period timer and commit any pending delete.
  // Without this, the timer fires against a torn-down component and the local
  // UI stays out of sync with the backend (row hidden, but never deleted).
  // We capture the latest pending state via a ref to avoid stale-closure
  // issues — the cleanup only runs at unmount.
  const pendingDeleteRef = useRef(pendingDelete);
  pendingDeleteRef.current = pendingDelete;
  const commitDeleteRef = useRef(conversations.commitDelete);
  commitDeleteRef.current = conversations.commitDelete;
  const pendingAgentDeleteRef = useRef(pendingAgentDelete);
  pendingAgentDeleteRef.current = pendingAgentDelete;
  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;
  useEffect(() => {
    return () => {
      const pending = pendingDeleteRef.current;
      if (pending) {
        clearTimeout(pending.timer);
        void commitDeleteRef.current(pending.item.id);
      }
      const pendingAgent = pendingAgentDeleteRef.current;
      if (pendingAgent && apiClientRef.current) {
        clearTimeout(pendingAgent.timer);
        void agentsApi.delete(apiClientRef.current, pendingAgent.item.id);
      }
    };
  }, []);

  async function handleCreateAgent(input: {
    name: string;
    description: string;
    instructions: string;
    model: string;
    reasoning: ReasoningLevel;
    tools: AgentToolName[];
    toolPreset: AgentToolPreset;
    toolInclude: AgentToolName[];
    toolExclude: AgentToolName[];
    skills?: string[] | null;
  }) {
    if (!apiClient) return;
    const id = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const created = await agentsApi.save(apiClient, {
      id,
      name: input.name,
      description: input.description,
      model: input.model,
      reasoning: input.reasoning,
      tools: input.tools,
      toolPreset: input.toolPreset,
      toolInclude: input.toolInclude,
      toolExclude: input.toolExclude,
      skills: input.skills ?? undefined,
      instructions: input.instructions,
    });
    setAgents((prev) => [...prev, created]);
    setSelectedAgentId(created.id);
    setView("chat");
  }

  async function handleSaveAgent(id: string, patch: AgentConfigPatch) {
    if (!apiClient) return;
    const saved = await agentsApi.update(apiClient, id, patch);
    setAgents((prev) => prev.map((agent) => (agent.id === saved.id ? saved : agent)));
    if (selectedAgentId === id) setSelectedAgentId(saved.id);
  }

  async function handleSaveAgentSkills(id: string, skills: string[] | null) {
    if (!apiClient) return;
    const saved = await agentsApi.update(apiClient, id, { skills });
    setAgents((prev) => prev.map((agent) => (agent.id === saved.id ? saved : agent)));
    if (selectedAgentId === id) setSelectedAgentId(saved.id);
  }

  async function handleListAgentFiles(id: string): Promise<AgentCoreFilesResponse> {
    if (!apiClient) throw new Error("Gateway is not ready");
    return agentsApi.listFiles(apiClient, id);
  }

  async function handleLoadAgentFile(id: string, name: string): Promise<string> {
    if (!apiClient) throw new Error("Gateway is not ready");
    return (await agentsApi.getFile(apiClient, id, name)).file.content ?? "";
  }

  async function handleSaveAgentFile(id: string, name: string, content: string): Promise<void> {
    if (!apiClient) throw new Error("Gateway is not ready");
    await agentsApi.setFile(apiClient, id, name, content);
  }

  /**
   * One-tap agent delete with a 5s undo grace period — mirrors the
   * conversation delete flow. The list hides the row immediately, a toast
   * surfaces the undo affordance, and the API DELETE only fires if the user
   * does not undo.
   */
  function handleDeleteAgent(id: string) {
    const target = agents.find((a) => a.id === id);
    if (!target) return;

    // Commit any prior pending agent delete so we don't pile up timers.
    if (pendingAgentDelete) {
      clearTimeout(pendingAgentDelete.timer);
      void commitAgentDelete(pendingAgentDelete.item.id);
    }

    setAgents((prev) => prev.filter((a) => a.id !== id));

    // If the deleted agent was selected, fall back to the next available one
    // so the editor pane doesn't stay stuck on a missing record.
    if (id === selectedAgentId) {
      const replacement = agents.find((a) => a.id !== id);
      if (replacement) setSelectedAgentId(replacement.id);
    }

    const timer = setTimeout(() => {
      setPendingAgentDelete(null);
      void commitAgentDelete(id);
    }, 5000);
    setPendingAgentDelete({ item: target, timer });
  }

  function handleUndoAgentDelete() {
    if (!pendingAgentDelete) return;
    clearTimeout(pendingAgentDelete.timer);
    setAgents((prev) => insertAgentByCreatedAt(prev, pendingAgentDelete.item));
    setPendingAgentDelete(null);
  }

  function handleDismissAgentToast() {
    if (!pendingAgentDelete) return;
    clearTimeout(pendingAgentDelete.timer);
    void commitAgentDelete(pendingAgentDelete.item.id);
    setPendingAgentDelete(null);
  }

  async function commitAgentDelete(id: string) {
    if (!apiClient) return;
    try {
      await agentsApi.delete(apiClient, id);
    } catch {
      // Refetch on error to reconcile local state with the backend.
      try {
        const fresh = await agentsApi.list(apiClient);
        setAgents(fresh);
      } catch {
        // best-effort
      }
    }
  }

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="shell-body">
        <div className="sidebar-frame">
          <WorkbenchSidebar
            view={view}
            onSelectView={(v) => {
              setView(v);
              if (v !== "chat") setHistoryOpen(false);
            }}
            onNewConversation={startNewConversation}
            historyOpen={historyOpen}
            onToggleHistory={() => setHistoryOpen((o) => !o)}
          />
        </div>
        <main className="chat-main-wrap content-panel">
          {runtime.data && (
            <div className="runtime-debug">
              gateway:{runtime.data.gateway.port} shell:{runtime.data.shell.port} · auth:
              {authLabel(authStatus)} · profile:{profile?.name ?? "Default"}
            </div>
          )}
          {view === "chat" ? (
            <ChatView
              agents={agents.map((a) => ({ id: a.id, name: a.name }))}
              selectedAgentId={selectedAgentId}
              onSelectAgent={setSelectedAgentId}
              messages={messages.items}
              messageUsages={messageUsages}
              runEvents={visibleRunEvents}
              runStatus={runStream.status}
              runError={runStream.error}
              sendError={sendError}
              submittingApprovals={approvals.submitting}
              resumingRun={resumingRun}
              onSend={handleSend}
              onCancel={handleCancel}
              onResume={handleResume}
              onDecide={approvals.decide}
              onboardingCard={onboardingCard}
              suggestions={chatSuggestions}
            />
          ) : null}
          {view === "agents" ? (
            <AgentsPage
              agents={agents}
              selectedAgentId={selectedAgentId}
              toolGroups={toolCatalog}
              onCreate={() => setNewAgentOpen(true)}
              onOpenChat={(id) => {
                setSelectedAgentId(id);
                setView("chat");
              }}
              onSave={handleSaveAgent}
              onListFiles={handleListAgentFiles}
              onLoadFile={handleLoadAgentFile}
              onSaveFile={handleSaveAgentFile}
              onDelete={handleDeleteAgent}
            />
          ) : null}
          {view === "skills" ? (
            <SkillsPage
              agents={agents}
              selectedAgentId={selectedAgentId}
              onSelectAgent={setSelectedAgentId}
              onLoadSkills={loadSkillsWithGatewayRestartFallback}
              onSaveAgentSkills={handleSaveAgentSkills}
            />
          ) : null}
          {view === "plugins" ? (
            <PlaceholderPage
              title="插件"
              description="MCP 服务器与第三方连接器（GitHub / Linear / Slack 等）。"
            />
          ) : null}
          {view === "tasks" ? (
            <PlaceholderPage
              title="定时任务"
              description="按 cron 计划自动唤起会话。"
            />
          ) : null}
          {view === "settings" ? (
            <SettingsPage
              authStatus={authStatus}
              browserStatus={browserStatus}
              agents={agents}
              selectedAgentId={selectedAgentId}
              profiles={profiles}
              activeProfileId={profile?.id ?? null}
              switchingProfileId={switchingProfileId}
              onSelectAgent={setSelectedAgentId}
              onListMemories={loadMemories}
              onGetMemoryStatus={loadMemoryStatus}
              onReindexMemory={reindexMemory}
              onCreateMemory={createMemory}
              onDeleteMemory={deleteMemory}
              onListMcpServers={loadMcpServers}
              onCreateMcpServer={createMcpServer}
              onUpdateMcpServer={updateMcpServer}
              onDeleteMcpServer={deleteMcpServer}
              onReconnectMcpServer={reconnectMcpServer}
              onListMcpServerTools={listMcpServerTools}
              onCreateProfile={handleCreateProfile}
              onSwitchProfile={handleSwitchProfile}
              onSignInWithChatGPT={handleSignInWithChatGPT}
              onSignOutCodex={handleSignOutCodex}
              onSaveApiKey={handleSaveApiKey}
              onClearApiKey={handleClearApiKey}
              onStartBrowserPairing={handleStartBrowserPairing}
            />
          ) : null}
        </main>
      </div>

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        items={conversations.items}
        activeId={activeConversationId}
        onSelect={(id) => {
          setActiveConversationId(id);
          setActiveRunId(null);
          setRetainedRunEvents({ conversationId: null, events: [] });
          setView("chat");
        }}
        onNew={startNewConversation}
        onDelete={handleDeleteConversation}
      />

      {pendingAgentDelete ? (
        <Toast
          message={`已删除智能体"${pendingAgentDelete.item.name || pendingAgentDelete.item.id}"`}
          action={{ label: "撤销", onClick: handleUndoAgentDelete }}
          onDismiss={handleDismissAgentToast}
        />
      ) : pendingDelete ? (
        <Toast
          message={`已删除"${pendingDelete.item.title || "(无标题)"}"`}
          action={{ label: "撤销", onClick: handleUndoDelete }}
          onDismiss={handleDismissDeleteToast}
        />
      ) : null}

      <NewAgentModal
        open={newAgentOpen}
        toolGroups={toolCatalog}
        onClose={() => setNewAgentOpen(false)}
        onCreate={handleCreateAgent}
      />
    </div>
  );
}
