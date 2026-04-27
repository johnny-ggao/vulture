import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AuthStatusView, ChatGPTLoginStart } from "./commandCenterTypes";
import { useRuntimeDescriptor } from "./runtime/useRuntimeDescriptor";
import { createApiClient } from "./api/client";
import { agentsApi, type Agent } from "./api/agents";
import { profileApi } from "./api/profile";
import { runsApi } from "./api/runs";
import { conversationsApi } from "./api/conversations";
import { AuthPanel } from "./chat/AuthPanel";
import { ConversationList } from "./chat/ConversationList";
import { ChatView } from "./chat/ChatView";
import { OnboardingCard } from "./chat/OnboardingCard";
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
  const restoredChatRef = useRef(readActiveChatState());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    restoredChatRef.current.conversationId,
  );
  const [activeRunId, setActiveRunId] = useState<string | null>(
    restoredChatRef.current.runId,
  );
  const sendingRunRef = useRef(false);

  const conversations = useConversations(apiClient);
  const messages = useMessages(apiClient, activeConversationId);
  const runStream = useRunStream({ client: apiClient, runId: activeRunId });
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

  // Bootstrap auth status once on mount (independent of gateway availability).
  useEffect(() => {
    void refreshAuthStatus();
  }, [refreshAuthStatus]);

  // When a run reaches a terminal status, refetch the conversation so the
  // assistant message persisted by the gateway appears in the chronological
  // message list (instead of only living in the transient runEvents).
  // Refetch is held in a ref so the effect only re-runs on status changes,
  // not on every render (messages object identity is unstable).
  const refetchMessagesRef = useRef(messages.refetch);
  refetchMessagesRef.current = messages.refetch;
  useEffect(() => {
    if (
      runStream.status === "succeeded" ||
      runStream.status === "failed" ||
      runStream.status === "cancelled"
    ) {
      void refetchMessagesRef.current();
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

  async function handleSend(input: string) {
    if (!apiClient || !selectedAgentId) return;
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

  function handleNew() {
    setActiveConversationId(null);
    setActiveRunId(null);
  }

  const authPanel = authStatus ? (
    <AuthPanel
      authStatus={authStatus}
      onSignInWithChatGPT={handleSignInWithChatGPT}
      onSignOutCodex={handleSignOutCodex}
      onSaveApiKey={handleSaveApiKey}
      onClearApiKey={handleClearApiKey}
    />
  ) : null;

  const onboardingCard =
    authStatus?.active === "none" ? (
      <OnboardingCard
        onSignInWithChatGPT={handleSignInWithChatGPT}
        onFocusApiKey={() => {}}
      />
    ) : null;

  return (
    <div className="app-shell">
      <ConversationList
        items={conversations.items}
        activeId={activeConversationId}
        onSelect={(id) => {
          setActiveConversationId(id);
          setActiveRunId(null);
        }}
        onNew={handleNew}
        footerSlot={authPanel}
      />
      <main className="chat-main-wrap">
        {runtime.data && (
          <div
            className="runtime-debug"
            style={{ fontSize: 11, opacity: 0.6, padding: "2px 8px" }}
          >
            gateway:{runtime.data.gateway.port} shell:{runtime.data.shell.port} · auth:
            {authLabel(authStatus)} · profile:{profile?.name ?? "Default"}
          </div>
        )}
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
          onSend={handleSend}
          onCancel={handleCancel}
          onDecide={approvals.decide}
          onboardingCard={onboardingCard}
        />
      </main>
    </div>
  );
}
