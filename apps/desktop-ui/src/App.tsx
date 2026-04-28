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
import { runsApi } from "./api/runs";
import { conversationsApi } from "./api/conversations";
import { AgentsPage } from "./chat/AgentsPage";
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
import { useConversations } from "./hooks/useConversations";
import { useMessages } from "./hooks/useMessages";
import { useRunStream } from "./hooks/useRunStream";
import { useApproval } from "./hooks/useApproval";

interface ProfileView {
  id: string;
  name: string;
  activeAgentId: string;
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

export function App() {
  const runtime = useRuntimeDescriptor();
  const apiClient = useMemo(
    () => (runtime.data ? createApiClient(runtime.data) : null),
    [runtime.data],
  );

  const [profile, setProfile] = useState<ProfileView | null>(null);
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
  const [runReconnectKey, setRunReconnectKey] = useState(0);
  const [resumingRun, setResumingRun] = useState(false);
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

  // Bootstrap auth status once on mount (independent of gateway availability).
  useEffect(() => {
    void refreshAuthStatus();
    void refreshBrowserStatus();
  }, [refreshAuthStatus, refreshBrowserStatus]);

  // When a run reaches a terminal status, refetch the conversation so the
  // assistant message persisted by the gateway appears in the chronological
  // message list (instead of only living in the transient runEvents).
  // Refetch is held in a ref so the effect only re-runs on status changes,
  // not on every render (messages object identity is unstable).
  const refetchMessagesRef = useRef(messages.refetch);
  refetchMessagesRef.current = messages.refetch;
  const refetchConversationsRef = useRef(conversations.refetch);
  refetchConversationsRef.current = conversations.refetch;
  useEffect(() => {
    if (
      runStream.status === "succeeded" ||
      runStream.status === "failed" ||
      runStream.status === "cancelled"
    ) {
      void refetchMessagesRef.current();
      void refetchConversationsRef.current();
      setActiveRunId(null);
      clearActiveRunId();
    }
  }, [runStream.status]);

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

  // Bootstrap profile + agents once when apiClient becomes available.
  useEffect(() => {
    if (!apiClient) return;
    let mounted = true;
    (async () => {
      try {
        const [profileResult, agentList] = await Promise.all([
          profileApi.get(apiClient),
          agentsApi.list(apiClient),
        ]);
        if (!mounted) return;
        setProfile({
          id: profileResult.id,
          name: profileResult.name,
          activeAgentId: profileResult.activeAgentId ?? "",
        });
        setAgents(agentList);
        setSelectedAgentId(
          (cur) => cur || profileResult.activeAgentId || agentList[0]?.id || "",
        );
      } catch {
        // surfaced via runtime.error or hook errors
      }
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

  async function handleSend(input: string) {
    if (!apiClient || !selectedAgentId || runStream.status === "recoverable" || resumingRun) {
      return;
    }
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
      const result = await runsApi.create(apiClient, cid, { input });
      setActiveRunId(result.run.id);
      messages.append(result.message);
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
    writeActiveChatState({ conversationId: null, runId: null });
  }

  function startNewConversation() {
    handleNew();
    setView("chat");
    setHistoryOpen(false);
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
      tools: ["shell.exec"],
      instructions: input.instructions,
    });
    setAgents((prev) => [...prev, created]);
    setSelectedAgentId(created.id);
    setView("chat");
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
              runEvents={
                runStream.status === "succeeded" ||
                runStream.status === "failed" ||
                runStream.status === "cancelled"
                  ? []
                  : runStream.events
              }
              runStatus={runStream.status}
              runError={runStream.error}
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
              onCreate={() => setNewAgentOpen(true)}
              onSelect={(id) => {
                setSelectedAgentId(id);
                setView("chat");
              }}
            />
          ) : null}
          {view === "skills" ? (
            <PlaceholderPage
              title="技能"
              description="可复用的提示词与工作流。安装后可被任何智能体启用。"
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
