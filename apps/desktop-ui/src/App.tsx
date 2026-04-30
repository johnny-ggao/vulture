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
import { conversationsApi, type ConversationDto, type MessageDto } from "./api/conversations";
import { subagentSessionsApi, type SubagentSessionDto } from "./api/subagentSessions";
import { FALLBACK_TOOL_CATALOG, toolsApi, type ToolCatalogGroup } from "./api/tools";
import { memoriesApi, type Memory, type MemoryStatus } from "./api/memories";
import {
  mcpServersApi,
  type McpServer,
  type McpToolSummary,
  type SaveMcpServer,
  type UpdateMcpServer,
} from "./api/mcpServers";
import {
  authLabel,
  DEFAULT_CHAT_SUGGESTIONS,
  delay,
  insertAgentByCreatedAt,
  isMissingMcpRoute,
  isMissingMemoriesRoute,
  isMissingToolsRoute,
  type ProfileListResponse,
  type ProfileView,
} from "./app/appHelpers";
import {
  loadSkillsWithGatewayRestartFallback as loadSkillsRetry,
  uploadAttachmentsWithGatewayRestartFallback as uploadAttachmentsRetry,
  withGatewayRestartForMissingRoute,
} from "./app/gatewayRestartFallback";
import { useUndoableDelete } from "./app/useUndoableDelete";
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
  const [subagentSessions, setSubagentSessions] = useState<SubagentSessionDto[]>([]);
  const [subagentMessages, setSubagentMessages] = useState<Record<string, MessageDto[]>>({});
  const [loadingSubagentMessages, setLoadingSubagentMessages] = useState<Set<string>>(new Set());
  const [runReconnectKey, setRunReconnectKey] = useState(0);
  const [resumingRun, setResumingRun] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendingRunRef = useRef(false);
  const [view, setView] = useState<ViewKey>("chat");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const conversations = useConversations(apiClient);

  // 5s soft-delete + undo for the conversation list. Commit closure
  // re-binds every render so it always sees the current apiClient.
  const conversationDelete = useUndoableDelete<ConversationDto>({
    commit: (item) => conversations.commitDelete(item.id),
  });
  // Same pattern for the agent list. The commit also reconciles with
  // a refetch on failure so the UI doesn't stay out of sync if the
  // DELETE call fails after the timer fires.
  const agentDelete = useUndoableDelete<Agent>({
    commit: async (item) => {
      if (!apiClient) return;
      try {
        await agentsApi.delete(apiClient, item.id);
      } catch {
        try {
          const fresh = await agentsApi.list(apiClient);
          setAgents(fresh);
        } catch {
          // best-effort
        }
      }
    },
  });

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
  const refetchSubagentSessionsRef = useRef<() => Promise<void>>(async () => undefined);
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
      setSubagentSessions([]);
      setSubagentMessages({});
      refetchSubagentSessionsRef.current = async () => undefined;
      return;
    }
    let cancelled = false;
    const refetch = async () => {
      try {
        const items = await subagentSessionsApi.list(apiClient, {
          parentConversationId: activeConversationId,
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
  }, [apiClient, activeConversationId]);

  useEffect(() => {
    const last = runStream.events[runStream.events.length - 1];
    if (!last || last.type !== "tool.completed") return;
    if (!isSessionsToolName(last.tool)) return;
    void refetchSubagentSessionsRef.current();
  }, [runStream.events]);

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

  async function handleCancel() {
    if (!apiClient || !activeRunId) return;
    try {
      await runsApi.cancel(apiClient, activeRunId);
    } catch {
      // ignore — UI will see run.cancelled via SSE
    }
  }

  async function loadMemories(agentId: string): Promise<Memory[]> {
    if (!apiClient) return [];
    return withGatewayRestartForMissingRoute(
      apiClient,
      () => memoriesApi.list(apiClient, agentId),
      isMissingMemoriesRoute,
    );
  }

  async function loadMemoryStatus(agentId: string): Promise<MemoryStatus | null> {
    if (!apiClient) return null;
    return withGatewayRestartForMissingRoute(
      apiClient,
      () => memoriesApi.status(apiClient, agentId),
      isMissingMemoriesRoute,
    );
  }

  async function reindexMemory(agentId: string): Promise<MemoryStatus> {
    if (!apiClient) throw new Error("API client is not ready");
    return withGatewayRestartForMissingRoute(
      apiClient,
      () => memoriesApi.reindex(apiClient, agentId),
      isMissingMemoriesRoute,
    );
  }

  async function createMemory(agentId: string, content: string): Promise<Memory> {
    if (!apiClient) throw new Error("API client is not ready");
    return withGatewayRestartForMissingRoute(
      apiClient,
      () => memoriesApi.create(apiClient, agentId, content),
      isMissingMemoriesRoute,
    );
  }

  async function deleteMemory(agentId: string, memoryId: string): Promise<void> {
    if (!apiClient) return;
    await withGatewayRestartForMissingRoute(
      apiClient,
      () => memoriesApi.delete(apiClient, agentId, memoryId),
      isMissingMemoriesRoute,
    );
  }

  async function loadMcpServers(): Promise<McpServer[]> {
    if (!apiClient) return [];
    return await withGatewayRestartForMissingRoute(
      apiClient,
      () => mcpServersApi.list(apiClient),
      isMissingMcpRoute,
    );
  }

  async function createMcpServer(input: SaveMcpServer): Promise<McpServer> {
    if (!apiClient) throw new Error("API client is not ready");
    return await withGatewayRestartForMissingRoute(
      apiClient,
      () => mcpServersApi.create(apiClient, input),
      isMissingMcpRoute,
    );
  }

  async function updateMcpServer(id: string, patch: UpdateMcpServer): Promise<McpServer> {
    if (!apiClient) throw new Error("API client is not ready");
    return await withGatewayRestartForMissingRoute(
      apiClient,
      () => mcpServersApi.update(apiClient, id, patch),
      isMissingMcpRoute,
    );
  }

  async function deleteMcpServer(id: string): Promise<void> {
    if (!apiClient) return;
    await withGatewayRestartForMissingRoute(
      apiClient,
      () => mcpServersApi.delete(apiClient, id),
      isMissingMcpRoute,
    );
  }

  async function reconnectMcpServer(id: string): Promise<McpServer> {
    if (!apiClient) throw new Error("API client is not ready");
    return await withGatewayRestartForMissingRoute(
      apiClient,
      () => mcpServersApi.reconnect(apiClient, id),
      isMissingMcpRoute,
    );
  }

  async function listMcpServerTools(id: string): Promise<McpToolSummary[]> {
    if (!apiClient) return [];
    return await withGatewayRestartForMissingRoute(
      apiClient,
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

  async function handleLoadSubagentMessages(sessionId: string): Promise<void> {
    if (!apiClient) return;
    setLoadingSubagentMessages((items) => new Set(items).add(sessionId));
    try {
      const result = await subagentSessionsApi.messages(apiClient, sessionId);
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
   * 5 seconds, and only call the API when the user does NOT undo. The
   * `useUndoableDelete` hook owns the timer + unmount-commit invariant;
   * this function only layers in the surface-specific bookkeeping
   * (clearing the active chat when the deleted row WAS active).
   */
  function handleDeleteConversation(id: string) {
    const target = conversations.items.find((c) => c.id === id);
    if (!target) return;

    conversations.softDelete(id);
    if (id === activeConversationId) {
      setActiveConversationId(null);
      setActiveRunId(null);
      setRetainedRunEvents({ conversationId: null, events: [] });
    }
    conversationDelete.startDelete(target);
  }

  function handleUndoDelete() {
    const restored = conversationDelete.undo();
    if (restored) conversations.restore(restored);
  }

  function handleDismissDeleteToast() {
    conversationDelete.dismiss();
  }

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
   * One-tap agent delete — mirrors the conversation delete flow via
   * `useUndoableDelete`. This wrapper handles the surface-specific
   * concerns (selection fallback, soft-delete via setAgents).
   */
  function handleDeleteAgent(id: string) {
    const target = agents.find((a) => a.id === id);
    if (!target) return;

    setAgents((prev) => prev.filter((a) => a.id !== id));
    if (id === selectedAgentId) {
      // Don't strand the editor pane on a missing record.
      const replacement = agents.find((a) => a.id !== id);
      if (replacement) setSelectedAgentId(replacement.id);
    }
    agentDelete.startDelete(target);
  }

  function handleUndoAgentDelete() {
    const restored = agentDelete.undo();
    if (restored) {
      setAgents((prev) => insertAgentByCreatedAt(prev, restored));
    }
  }

  function handleDismissAgentToast() {
    agentDelete.dismiss();
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
              subagentSessions={subagentSessions}
              subagentMessages={subagentMessages}
              loadingSubagentMessages={loadingSubagentMessages}
              onLoadSubagentMessages={handleLoadSubagentMessages}
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
              onLoadSkills={(agentId) => loadSkillsRetry(apiClient, agentId)}
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
        agents={agents}
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

      {agentDelete.pending ? (
        <Toast
          message={`已删除智能体"${agentDelete.pending.name || agentDelete.pending.id}"`}
          action={{ label: "撤销", onClick: handleUndoAgentDelete }}
          onDismiss={handleDismissAgentToast}
        />
      ) : conversationDelete.pending ? (
        <Toast
          message={`已删除"${conversationDelete.pending.title || "(无标题)"}"`}
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

function isSessionsToolName(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("sessions_");
}
