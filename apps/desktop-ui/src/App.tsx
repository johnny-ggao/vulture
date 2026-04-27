import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import type {
  CodexLoginRequest,
  CodexLoginStart,
  OpenAiAuthStatus,
} from "./commandCenterTypes";
import { useRuntimeDescriptor } from "./runtime/useRuntimeDescriptor";
import { createApiClient } from "./api/client";
import { agentsApi, type Agent } from "./api/agents";
import { profileApi } from "./api/profile";
import { runsApi } from "./api/runs";
import { ConversationList } from "./chat/ConversationList";
import { ChatView } from "./chat/ChatView";
import { useConversations } from "./hooks/useConversations";
import { useMessages } from "./hooks/useMessages";
import { useRunStream } from "./hooks/useRunStream";
import { useApproval } from "./hooks/useApproval";

interface ProfileView {
  id: string;
  name: string;
  activeAgentId: string;
}

function authLabel(status: OpenAiAuthStatus | null) {
  if (!status?.configured) return "未认证";
  if (status.source === "codex") return "Codex OAuth";
  if (status.source === "environment") return "OPENAI_API_KEY";
  return "Keychain API key";
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
  const [authStatus, setAuthStatus] = useState<OpenAiAuthStatus | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const conversations = useConversations(apiClient);
  const messages = useMessages(apiClient, activeConversationId);
  const runStream = useRunStream({ client: apiClient, runId: activeRunId });
  const approvals = useApproval({
    client: apiClient,
    runId: activeRunId,
    events: runStream.events,
  });

  // Bootstrap auth + profile + agents once when apiClient becomes available.
  useEffect(() => {
    if (!apiClient) return;
    let mounted = true;
    (async () => {
      try {
        const [profileResult, agentList, nextAuthStatus] = await Promise.all([
          profileApi.get(apiClient),
          agentsApi.list(apiClient),
          invoke<OpenAiAuthStatus>("get_openai_auth_status").catch(() => null),
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
        if (nextAuthStatus) setAuthStatus(nextAuthStatus);
      } catch {
        // surfaced via runtime.error or hook errors
      }
    })();
    return () => {
      mounted = false;
    };
  }, [apiClient]);

  async function handleSend(input: string) {
    if (!apiClient || !selectedAgentId) return;
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
          runEvents={runStream.events}
          runStatus={runStream.status}
          runError={runStream.error}
          submittingApprovals={approvals.submitting}
          onSend={handleSend}
          onCancel={handleCancel}
          onDecide={approvals.decide}
        />
      </main>
    </div>
  );
}
