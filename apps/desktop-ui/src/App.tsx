import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import type {
  AuthStatusView,
  BrowserRelayStatus,
  ChatGPTLoginStart,
} from "./commandCenterTypes";
import { useRuntimeDescriptor } from "./runtime/useRuntimeDescriptor";
import { createApiClient } from "./api/client";
import { agentsApi, type Agent, type AgentCoreFilesResponse, type AgentToolName, type AgentToolPreset, type ReasoningLevel } from "./api/agents";
import { type ConversationDto } from "./api/conversations";
import { runLogsApi, type ListRunLogsQuery } from "./api/runLogs";
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
  insertAgentByCreatedAt,
  isMissingMcpRoute,
  isMissingMemoriesRoute,
  isMissingRunLogsRoute,
  type ProfileListResponse,
  type ProfileView,
} from "./app/appHelpers";
import {
  loadSkillsWithGatewayRestartFallback as loadSkillsRetry,
  withGatewayRestartForMissingRoute,
} from "./app/gatewayRestartFallback";
import { useGatewayBootstrap } from "./app/useGatewayBootstrap";
import { useRunController } from "./app/useRunController";
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
import { useConversations } from "./hooks/useConversations";

export function App() {
  const runtime = useRuntimeDescriptor();
  const apiClient = useMemo(
    () => (runtime.data ? createApiClient(runtime.data) : null),
    [runtime.data],
  );

  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [switchingProfileId, setSwitchingProfileId] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusView | null>(null);
  const [browserStatus, setBrowserStatus] = useState<BrowserRelayStatus | null>(null);
  const [view, setView] = useState<ViewKey>("chat");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const conversations = useConversations(apiClient);
  const {
    profile,
    setProfile,
    agents,
    setAgents,
    toolCatalog,
    selectedAgentId,
    setSelectedAgentId,
    loadGatewayState,
  } = useGatewayBootstrap({
    apiClient,
    refetchConversations: conversations.refetch,
  });
  const runController = useRunController({
    apiClient,
    selectedAgentId,
    conversations,
  });

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

  async function listRunLogs(query: ListRunLogsQuery) {
    if (!apiClient) return { items: [], nextOffset: null };
    return withGatewayRestartForMissingRoute(
      apiClient,
      () => runLogsApi.list(apiClient, query),
      isMissingRunLogsRoute,
    );
  }

  async function loadRunTrace(runId: string) {
    if (!apiClient) throw new Error("Gateway is not ready");
    return runLogsApi.trace(apiClient, runId);
  }

  function startNewConversation() {
    runController.startNewConversation();
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
      runController.resetForProfileSwitch();
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
    runController.clearActiveConversationIfMatches(id);
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
              permissionMode={runController.permissionMode}
              onChangePermissionMode={runController.changePermissionMode}
              messages={runController.messages.items}
              messageUsages={runController.messageUsages}
              subagentSessions={runController.subagentSessions}
              subagentMessages={runController.subagentMessages}
              loadingSubagentMessages={runController.loadingSubagentMessages}
              onLoadSubagentMessages={runController.loadSubagentMessages}
              runEvents={runController.visibleRunEvents}
              runStatus={runController.runStream.status}
              runError={runController.runStream.error}
              sendError={runController.sendError}
              submittingApprovals={runController.approvals.submitting}
              resumingRun={runController.resumingRun}
              onSend={runController.send}
              onCancel={runController.cancel}
              onResume={runController.resume}
              onDecide={runController.approvals.decide}
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
              onListRunLogs={listRunLogs}
              onLoadRunTrace={loadRunTrace}
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
        activeId={runController.activeConversationId}
        onSelect={(id) => {
          runController.selectConversation(id);
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
