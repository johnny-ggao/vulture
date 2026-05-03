import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AuthStatusView,
  BrowserRelayStatus,
  ChatGPTLoginStart,
} from "./commandCenterTypes";
import { useRuntimeDescriptor } from "./runtime/useRuntimeDescriptor";
import { createApiClient } from "./api/client";
import { agentsApi, type Agent, type AgentCoreFilesResponse, type AgentToolName, type AgentToolPreset, type ReasoningLevel } from "./api/agents";
import { artifactsApi, type ListArtifactsQuery } from "./api/artifacts";
import { type ConversationDto } from "./api/conversations";
import { runLogsApi, type ListRunLogsQuery } from "./api/runLogs";
import {
  webSearchSettingsApi,
  type UpdateWebSearchSettings,
} from "./api/webSearchSettings";
import { memoriesApi, type Memory, type MemoryStatus } from "./api/memories";
import {
  mcpServersApi,
  type McpServer,
  type McpToolSummary,
  type SaveMcpServer,
  type UpdateMcpServer,
} from "./api/mcpServers";
import {
  DEFAULT_CHAT_SUGGESTIONS,
  insertAgentByCreatedAt,
  isMissingMcpRoute,
  isMissingMemoriesRoute,
  isMissingRunLogsRoute,
  isMissingWebSearchRoute,
  type ProfileListResponse,
  type ProfileView,
} from "./app/appHelpers";
import {
  loadSkillsWithGatewayRestartFallback as loadSkillsRetry,
  withGatewayRestartForMissingRoute,
} from "./app/gatewayRestartFallback";
import { skillsApi } from "./api/skills";
import { useGatewayBootstrap } from "./app/useGatewayBootstrap";
import { useRunController } from "./app/useRunController";
import { useUndoableDelete } from "./app/useUndoableDelete";
import { AgentsPage, type AgentConfigPatch } from "./chat/AgentsPage";
import type { AgentsTab } from "./chat/AgentEditModal";
import { ArtifactsPage } from "./chat/ArtifactsPage";
import { SkillsPage } from "./chat/SkillsPage";
import { ChatView } from "./chat/ChatView";
import { CommandPalette, useCommandPalette, type Command } from "./chat/CommandPalette";
import { HistoryDrawer } from "./chat/HistoryDrawer";
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
  // Drives the CodingAgentBanner → AgentEditModal flow. Set when the
  // user clicks the banner; consumed once by AgentsPage on mount.
  const [agentEditTarget, setAgentEditTarget] = useState<{
    agentId: string;
    tab: AgentsTab;
  } | null>(null);
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

  useEffect(() => {
    if (!browserStatus?.enabled) return;
    const timer = window.setInterval(() => {
      void refreshBrowserStatus();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [browserStatus?.enabled, refreshBrowserStatus]);

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

  async function listArtifacts(query: ListArtifactsQuery) {
    if (!apiClient) return { items: [] };
    return artifactsApi.list(apiClient, query);
  }

  async function loadRunTrace(runId: string) {
    if (!apiClient) throw new Error("Gateway is not ready");
    return runLogsApi.trace(apiClient, runId);
  }

  async function getWebSearchSettings() {
    if (!apiClient) throw new Error("Gateway is not ready");
    return withGatewayRestartForMissingRoute(
      apiClient,
      () => webSearchSettingsApi.get(apiClient),
      isMissingWebSearchRoute,
    );
  }

  async function updateWebSearchSettings(input: UpdateWebSearchSettings) {
    if (!apiClient) throw new Error("Gateway is not ready");
    return withGatewayRestartForMissingRoute(
      apiClient,
      () => webSearchSettingsApi.update(apiClient, input),
      isMissingWebSearchRoute,
    );
  }

  async function testWebSearchSettings(input: UpdateWebSearchSettings & { query?: string }) {
    if (!apiClient) throw new Error("Gateway is not ready");
    return withGatewayRestartForMissingRoute(
      apiClient,
      () => webSearchSettingsApi.test(apiClient, input),
      isMissingWebSearchRoute,
    );
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

  async function handleCreateAgent(patch: AgentConfigPatch) {
    if (!apiClient) return;
    const id = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const created = await agentsApi.save(apiClient, {
      id,
      name: patch.name,
      description: patch.description,
      model: patch.model,
      reasoning: patch.reasoning,
      tools: patch.tools,
      toolPreset: patch.toolPreset,
      toolInclude: patch.toolInclude,
      toolExclude: patch.toolExclude,
      skills: patch.skills ?? undefined,
      instructions: patch.instructions,
    });
    setAgents((prev) => [...prev, created]);
    setSelectedAgentId(created.id);
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

  // Called by ChatView when the user clicks the CodingAgentBanner.
  // Switches to the Agents view and opens the edit modal for that agent.
  function handleOpenAgentEdit(agentId: string) {
    setAgentEditTarget({ agentId, tab: "overview" });
    setSelectedAgentId(agentId);
    setView("agents");
  }

  // Stable callback so AgentsPage's useEffect doesn't re-fire on every
  // App render. AgentsPage calls this once after consuming the target;
  // clearing the state prevents the modal from re-opening when the user
  // navigates away from the agents view and back (AgentsPage remounts).
  const consumeAgentEditTarget = useCallback(() => {
    setAgentEditTarget(null);
  }, []);

  // ---- Keyboard shortcuts ---------------------------------------
  // ⌘1-6 / Ctrl+1-6 jump between primary views. ⌘N starts a new
  // conversation (skipped when typing in any input/textarea so the
  // shortcut never blackholes a keystroke). ⌘K is owned by the
  // command palette below and not re-handled here.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.shiftKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTyping =
        tag === "input" ||
        tag === "textarea" ||
        target?.isContentEditable === true;

      const VIEW_KEYS: ViewKey[] = [
        "chat",
        "agents",
        "skills",
        "artifacts",
        "plugins",
        "tasks",
        "settings",
      ];
      if (event.key >= "1" && event.key <= "7") {
        if (isTyping) return;
        const idx = Number.parseInt(event.key, 10) - 1;
        const target = VIEW_KEYS[idx];
        if (target) {
          event.preventDefault();
          setView(target);
          setHistoryOpen(false);
        }
        return;
      }
      if (event.key === "n" || event.key === "N") {
        if (isTyping) return;
        event.preventDefault();
        startNewConversation();
        return;
      }
      // ⌘, — macOS standard "open application preferences". Always
      // valid (even while typing in the composer); preferences should
      // not be blackholed by an active text field.
      if (event.key === ",") {
        event.preventDefault();
        setView("settings");
        setHistoryOpen(false);
        return;
      }
      // ⌘B — toggle history drawer (sidebar-bar mnemonic). Skipped
      // while typing so it doesn't blackhole the bold-text shortcut.
      if (event.key === "b" || event.key === "B") {
        if (isTyping) return;
        event.preventDefault();
        setHistoryOpen((open) => !open);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // startNewConversation is recreated each render but its identity
    // doesn't matter for the shortcut — we want the latest closure.
    // Re-binding on every render is cheap and keeps the closure live.
  });

  // ---- Skip-link + focus-on-route-change ------------------------
  // Keyboard users land on the skip-link as the first focusable
  // element; activating it moves focus into <main>, jumping over
  // the titlebar/sidebar. We also focus main programmatically when
  // the view changes so screen-reader users land on the new content
  // region instead of being stranded on the previously-active tab.
  const mainRef = useRef<HTMLElement | null>(null);
  const lastViewRef = useRef<ViewKey | null>(null);
  useEffect(() => {
    // Skip the very first render — focusing main on initial load
    // would steal focus from any auto-focused element on the page
    // (e.g. the composer textarea). Only react to actual view changes.
    if (lastViewRef.current === null) {
      lastViewRef.current = view;
      return;
    }
    if (lastViewRef.current === view) return;
    lastViewRef.current = view;
    queueMicrotask(() => mainRef.current?.focus({ preventScroll: true }));
  }, [view]);

  // ---- Command Palette (⌘K) -------------------------------------
  // Global shortcut hook owns the open/close state. The command list
  // is recomputed each render so it always reflects the latest agents,
  // profiles, and view — there's no need to invalidate it manually.
  const palette = useCommandPalette();

  const paletteCommands = useMemo<ReadonlyArray<Command>>(() => {
    const cmds: Command[] = [];

    // Navigate group — primary view switcher. Shortcut digits mirror
    // the ⌘1-7 listener so the palette is a discoverability surface
    // for the same keystrokes (no duplicate handler).
    const VIEW_LABELS: Array<{ key: ViewKey; label: string; digit: string }> = [
      { key: "chat", label: "对话", digit: "1" },
      { key: "agents", label: "智能体", digit: "2" },
      { key: "skills", label: "技能", digit: "3" },
      { key: "artifacts", label: "产物", digit: "4" },
      { key: "plugins", label: "插件", digit: "5" },
      { key: "tasks", label: "定时任务", digit: "6" },
      { key: "settings", label: "设置", digit: "7" },
    ];
    for (const { key, label, digit } of VIEW_LABELS) {
      cmds.push({
        id: `view:${key}`,
        label: `跳到「${label}」`,
        group: "导航",
        keywords: [key, "view", "switch", "navigate"],
        shortcut: ["⌘", digit],
        execute: () => {
          setView(key);
          setHistoryOpen(false);
        },
      });
    }
    cmds.push({
      id: "history:toggle",
      label: historyOpen ? "关闭历史抽屉" : "打开历史抽屉",
      group: "导航",
      keywords: ["history", "drawer", "记录"],
      shortcut: ["⌘", "B"],
      execute: () => setHistoryOpen((open) => !open),
    });
    cmds.push({
      id: "view:settings:prefs",
      label: "打开设置",
      group: "导航",
      keywords: ["settings", "preferences", "设置", "config"],
      shortcut: ["⌘", ","],
      execute: () => {
        setView("settings");
        setHistoryOpen(false);
      },
    });

    // Action group — common one-shot operations.
    cmds.push({
      id: "action:new-conversation",
      label: "新建对话",
      group: "操作",
      keywords: ["chat", "new", "session", "对话"],
      shortcut: ["⌘", "N"],
      execute: () => {
        startNewConversation();
      },
    });
    cmds.push({
      id: "action:new-agent",
      label: "新建智能体",
      group: "操作",
      keywords: ["agent", "create", "new"],
      execute: () => setView("agents"),
    });
    const runStatus = runController.runStream.status;
    if (
      runStatus === "streaming" ||
      runStatus === "connecting" ||
      runStatus === "reconnecting"
    ) {
      cmds.push({
        id: "action:cancel-run",
        label: "取消当前运行",
        group: "操作",
        keywords: ["cancel", "stop", "abort", "取消"],
        shortcut: ["⌘", "."],
        execute: () => runController.cancel(),
      });
    }

    // Switch agent group — one row per agent in the current profile.
    if (agents.length > 0) {
      for (const agent of agents) {
        const isSelected = agent.id === selectedAgentId;
        cmds.push({
          id: `agent:${agent.id}`,
          label: `切换到 ${agent.name || agent.id}`,
          description: agent.id,
          group: "切换智能体",
          keywords: [agent.id, agent.description ?? "", "agent"],
          execute: () => {
            setSelectedAgentId(agent.id);
            setView("chat");
            setHistoryOpen(false);
          },
        });
        if (isSelected) {
          // Surface a hint so the user can tell which agent is current
          // even when they're searching by name.
          cmds[cmds.length - 1] = {
            ...cmds[cmds.length - 1]!,
            description: `${agent.id} · 当前`,
          };
        }
      }
    }

    // Switch profile group — only meaningful when more than one profile
    // exists. Active profile gets a hint in its description.
    if (profiles.length > 1) {
      for (const p of profiles) {
        cmds.push({
          id: `profile:${p.id}`,
          label: `切换到 Profile「${p.name}」`,
          description: p.id === profile?.id ? "当前 profile" : p.id,
          group: "切换 Profile",
          keywords: [p.id, p.name, "profile"],
          execute: () => {
            void handleSwitchProfile(p.id);
          },
        });
      }
    }

    return cmds;
    // Recompute when any input changes; stable list rendering is
    // guaranteed by stable command ids.
  }, [
    agents,
    selectedAgentId,
    profiles,
    profile?.id,
    historyOpen,
    runController.runStream.status,
  ]);

  return (
    <div className="app-shell">
      {/* Skip-link — invisible until keyboard-focused, then surfaces
          as a brand-tinted pill at the top-left and jumps the user
          straight to <main>, bypassing the titlebar + sidebar. */}
      <a
        href="#main-content"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus({ preventScroll: false });
        }}
      >
        跳到主内容
      </a>
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
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="chat-main-wrap content-panel"
          aria-label={
            view === "chat" ? "对话" :
            view === "agents" ? "智能体" :
            view === "skills" ? "技能" :
            view === "artifacts" ? "产物" :
            view === "plugins" ? "插件" :
            view === "tasks" ? "定时任务" :
            view === "settings" ? "设置" :
            "主内容"
          }
        >
          {view === "chat" ? (
            <ChatView
              agents={agents.map((a) => ({ id: a.id, name: a.name, isPrivateWorkspace: a.isPrivateWorkspace }))}
              selectedAgentId={selectedAgentId}
              onSelectAgent={setSelectedAgentId}
              onOpenAgentEdit={handleOpenAgentEdit}
              permissionMode={runController.permissionMode}
              onChangePermissionMode={runController.changePermissionMode}
              messages={runController.messages.items}
              messageUsages={runController.messageUsages}
              subagentSessions={runController.subagentSessions}
              subagentMessages={runController.subagentMessages}
              loadingSubagentMessages={runController.loadingSubagentMessages}
              submittingSubagentApprovals={runController.subagentApprovalSubmitting}
              onLoadSubagentMessages={runController.loadSubagentMessages}
              onDecideSubagentApproval={runController.decideSubagentApproval}
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
              authStatus={authStatus}
              onCreate={handleCreateAgent}
              onOpenChat={(id) => {
                setSelectedAgentId(id);
                setView("chat");
              }}
              onSave={handleSaveAgent}
              onListFiles={handleListAgentFiles}
              onLoadFile={handleLoadAgentFile}
              onSaveFile={handleSaveAgentFile}
              onDelete={handleDeleteAgent}
              initialEditTarget={agentEditTarget}
              onConsumeEditTarget={consumeAgentEditTarget}
            />
          ) : null}
          {view === "skills" ? (
            <SkillsPage
              agents={agents}
              selectedAgentId={selectedAgentId}
              onSelectAgent={setSelectedAgentId}
              onLoadSkills={(agentId) => loadSkillsRetry(apiClient, agentId)}
              onLoadSkillCatalog={() => {
                if (!apiClient) throw new Error("Gateway is not ready");
                return skillsApi.listCatalog(apiClient);
              }}
              onImportSkillPackage={(packagePath) => {
                if (!apiClient) throw new Error("Gateway is not ready");
                return skillsApi.importCatalogPackage(apiClient, { packagePath, source: "local" });
              }}
              onInstallSkill={(name) => {
                if (!apiClient) throw new Error("Gateway is not ready");
                return skillsApi.installCatalogEntry(apiClient, name);
              }}
              onUpdateSkillCatalog={() => {
                if (!apiClient) throw new Error("Gateway is not ready");
                return skillsApi.updateCatalog(apiClient);
              }}
              onSaveAgentSkills={handleSaveAgentSkills}
            />
          ) : null}
          {view === "artifacts" ? (
            <ArtifactsPage
              agents={agents}
              selectedAgentId={selectedAgentId}
              onListArtifacts={listArtifacts}
            />
          ) : null}
          {view === "plugins" ? (
            <PlaceholderPage
              title="插件"
              description="把第三方服务接进工作台，扩展智能体的能力边界。"
              status="即将上线"
              icon={
                <svg
                  viewBox="0 0 24 24"
                  width="28"
                  height="28"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 4h3a3 3 0 0 1 3 3v3" />
                  <path d="M20 14v3a3 3 0 0 1-3 3h-3" />
                  <path d="M10 20H7a3 3 0 0 1-3-3v-3" />
                  <path d="M4 10V7a3 3 0 0 1 3-3h3" />
                  <path d="M9 9h6v6H9z" />
                </svg>
              }
              teasers={[
                "MCP 服务器：将本地 stdio / HTTP 工具广播给所有智能体",
                "服务连接器：GitHub / Linear / Slack / Notion 一键授权",
                "插件市场：浏览社区贡献的能力包并按需启用",
              ]}
            />
          ) : null}
          {view === "tasks" ? (
            <PlaceholderPage
              title="定时任务"
              description="按 cron 计划自动唤起智能体执行预设任务，结果汇总到收件箱。"
              status="即将上线"
              icon={
                <svg
                  viewBox="0 0 24 24"
                  width="28"
                  height="28"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="13" r="8" />
                  <path d="M12 9v4l2.5 2" />
                  <path d="M9 2h6" />
                  <path d="M12 2v3" />
                </svg>
              }
              teasers={[
                "Cron 调度：每天 / 每周 / 自定义表达式触发",
                "结果汇总：自动整理产物到收件箱并按需推送",
                "失败重试：异常时自动续跑或转人工审批",
              ]}
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
              onGetWebSearchSettings={getWebSearchSettings}
              onUpdateWebSearchSettings={updateWebSearchSettings}
              onTestWebSearchSettings={testWebSearchSettings}
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

      <CommandPalette
        isOpen={palette.isOpen}
        onClose={palette.close}
        commands={paletteCommands}
      />
    </div>
  );
}
