import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AuthStatusView,
  BrowserRelayStatus,
  ChatGPTLoginStart,
} from "./commandCenterTypes";
import { useRuntimeDescriptor } from "./runtime/useRuntimeDescriptor";
import { createApiClient } from "./api/client";
import { agentsApi, type Agent } from "./api/agents";
import { profileApi } from "./api/profile";
import { runsApi, type RunDto, type TokenUsageDto } from "./api/runs";
import { conversationsApi } from "./api/conversations";
import { attachmentsApi } from "./api/attachments";
import { skillsApi, type SkillListResponse } from "./api/skills";
import { AgentsPage, type AgentConfigPatch } from "./chat/AgentsPage";
import { SkillsPage } from "./chat/SkillsPage";
import { ChatView } from "./chat/ChatView";
import { HistoryDrawer } from "./chat/HistoryDrawer";
import { NewAgentModal } from "./chat/NewAgentModal";
import { OnboardingCard } from "./chat/OnboardingCard";
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

  async function handleCreateAgent(input: { name: string; description: string; instructions: string }) {
    if (!apiClient) return;
    const id = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const created = await agentsApi.save(apiClient, {
      id,
      name: input.name,
      description: input.description,
      model: "gpt-5.5",
      reasoning: "low",
      tools: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "shell.exec",
        "process",
        "web_search",
        "web_fetch",
        "sessions_list",
        "sessions_history",
        "sessions_send",
        "sessions_spawn",
        "sessions_yield",
        "update_plan",
      ],
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
            />
          ) : null}
          {view === "agents" ? (
            <AgentsPage
              agents={agents}
              selectedAgentId={selectedAgentId}
              onCreate={() => setNewAgentOpen(true)}
              onOpenChat={(id) => {
                setSelectedAgentId(id);
                setView("chat");
              }}
              onSave={handleSaveAgent}
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
              profiles={profiles}
              activeProfileId={profile?.id ?? null}
              switchingProfileId={switchingProfileId}
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
      />

      <NewAgentModal
        open={newAgentOpen}
        onClose={() => setNewAgentOpen(false)}
        onCreate={handleCreateAgent}
      />
    </div>
  );
}
