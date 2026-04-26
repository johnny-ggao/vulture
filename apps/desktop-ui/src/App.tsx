import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import type {
  AgentView,
  CodexLoginRequest,
  CodexLoginStart,
  OpenAiAuthStatus,
} from "./commandCenterTypes";

type RunEvent = {
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
};

type Profile = {
  id: string;
  name: string;
  activeAgentId: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

const starterPrompts = [
  "总结这个 workspace 的结构和下一步建议",
  "检查当前项目最需要优先完善的功能",
  "帮我分析这个桌面 agent 的运行链路",
];

const previewWorkspace = {
  id: "vulture",
  name: "Vulture",
  path: "~/Library/Application Support/Vulture/profiles/default/agents/local-work-agent/workspace",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const previewAgent: AgentView = {
  id: "local-work-agent",
  name: "Local Work Agent",
  description: "General local work assistant",
  model: "gpt-5.4",
  reasoning: "medium",
  tools: ["shell.exec", "browser.snapshot", "browser.click"],
  workspace: previewWorkspace,
  instructions: "You are Vulture's local work agent.",
};

function authLabel(status: OpenAiAuthStatus | null) {
  if (!status?.configured) return "未认证";
  if (status.source === "codex") return "Codex OAuth";
  if (status.source === "environment") return "OPENAI_API_KEY";
  return "Keychain API key";
}

export function App() {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [authStatus, setAuthStatus] = useState<OpenAiAuthStatus | null>(null);
  const [codexLogin, setCodexLogin] = useState<CodexLoginStart | null>(null);
  const [codexLoginStatus, setCodexLoginStatus] = useState("idle");
  const [authRefreshStatus, setAuthRefreshStatus] = useState("idle");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [taskInput, setTaskInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const isRunning = useRef(false);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const codexAuthenticated = authStatus?.source === "codex" || codexLogin?.alreadyAuthenticated;
  const canSend =
    Boolean(selectedAgent && taskInput.trim() && authStatus?.configured) && status !== "running";

  useEffect(() => {
    let isMounted = true;

    async function loadChatShell() {
      try {
        const [profileResult, agentList, nextAuthStatus] = await Promise.all([
          invoke<Profile>("get_profile"),
          invoke<AgentView[]>("list_agents"),
          invoke<OpenAiAuthStatus>("get_openai_auth_status"),
        ]);

        if (!isMounted) return;
        setProfile(profileResult);
        setAgents(agentList);
        setAuthStatus(nextAuthStatus);
        setSelectedAgentId(
          (current) => current || profileResult.activeAgentId || agentList[0]?.id || "",
        );
      } catch (cause) {
        if (!isMounted) return;
        if (isTauriUnavailable(cause)) {
          setProfile({ id: "default", name: "Preview", activeAgentId: previewAgent.id });
          setAgents([previewAgent]);
          setAuthStatus({ configured: false, source: "missing" });
          setSelectedAgentId(previewAgent.id);
          return;
        }
        setError(errorMessage(cause));
      }
    }

    loadChatShell();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (codexLoginStatus !== "waiting") return;

    let checks = 0;
    const interval = window.setInterval(async () => {
      checks += 1;
      try {
        const nextAuthStatus = await invoke<OpenAiAuthStatus>("get_openai_auth_status");
        setAuthStatus(nextAuthStatus);
        if (nextAuthStatus.source === "codex") {
          setCodexLoginStatus("completed");
          window.clearInterval(interval);
        }
      } catch {
        // Keep polling while the browser auth flow is in progress.
      }
      if (checks >= 80) {
        setCodexLoginStatus("idle");
        window.clearInterval(interval);
      }
    }, 3000);

    return () => window.clearInterval(interval);
  }, [codexLoginStatus]);

  async function startCodexLogin(forceReauth = false) {
    setError(null);
    setCodexLoginStatus("starting");
    setAuthRefreshStatus("idle");

    try {
      const request: CodexLoginRequest = { forceReauth };
      const result = await invoke<CodexLoginStart>("start_codex_login", { request });
      setCodexLogin(result);
      setCodexLoginStatus(result.alreadyAuthenticated ? "completed" : "waiting");
      const nextAuthStatus = await invoke<OpenAiAuthStatus>("get_openai_auth_status");
      setAuthStatus(nextAuthStatus);
    } catch (cause) {
      setCodexLoginStatus("failed");
      setError(errorMessage(cause));
    }
  }

  async function refreshAuthStatus() {
    setError(null);
    setAuthRefreshStatus("refreshing");

    try {
      const result = await invoke<OpenAiAuthStatus>("get_openai_auth_status");
      setAuthStatus(result);
      setAuthRefreshStatus("idle");
      if (result.source === "codex") {
        setCodexLoginStatus("completed");
      }
    } catch (cause) {
      setAuthRefreshStatus("failed");
      setError(errorMessage(cause));
    }
  }

  async function saveApiKey() {
    setError(null);

    try {
      const result = await invoke<OpenAiAuthStatus>("set_openai_api_key", {
        request: { apiKey: apiKeyInput },
      });
      setAuthStatus(result);
      setApiKeyInput("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function sendMessage() {
    const input = taskInput.trim();
    if (isRunning.current || !input || !selectedAgent) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: input,
    };
    setMessages((current) => [...current, userMessage]);
    setTaskInput("");
    setStatus("running");
    setError(null);
    setEvents([]);
    isRunning.current = true;

    if (!isTauriRuntime()) {
      setStatus("failed");
      setError("请在 Tauri 桌面窗口中运行真实任务。");
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: "当前只是浏览器预览。真实 agent 运行需要通过 Tauri 桌面窗口启动。",
        },
      ]);
      isRunning.current = false;
      return;
    }

    try {
      const result = await invoke<RunEvent[]>("start_agent_run", {
        request: {
          agentId: selectedAgent.id,
          input,
        },
      });
      setEvents(result);
      setStatus("completed");
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistantTextFromEvents(result),
        },
      ]);
    } catch (cause) {
      const message = errorMessage(cause);
      setStatus("failed");
      setError(message);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: message,
        },
      ]);
    } finally {
      isRunning.current = false;
    }
  }

  async function sendMockMessage() {
    const input = taskInput.trim() || "Summarize this workspace";
    if (isRunning.current) return;

    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: input },
    ]);
    setTaskInput("");
    setStatus("running");
    setError(null);
    setEvents([]);
    isRunning.current = true;

    if (!isTauriRuntime()) {
      setStatus("completed");
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Mock response for: ${input}`,
        },
      ]);
      isRunning.current = false;
      return;
    }

    try {
      const result = await invoke<RunEvent[]>("start_mock_run", { input });
      setEvents(result);
      setStatus("completed");
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistantTextFromEvents(result),
        },
      ]);
    } catch (cause) {
      const message = errorMessage(cause);
      setStatus("failed");
      setError(message);
    } finally {
      isRunning.current = false;
    }
  }

  return (
    <div className="app-shell">
      <aside className="chat-sidebar">
        <div className="window-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="brand">
          <div className="brand-mark">V</div>
          <strong>Vulture Work</strong>
        </div>

        <button
          type="button"
          className="nav-item active"
          onClick={() => {
            setMessages([]);
            setTaskInput("");
            setEvents([]);
            setStatus("idle");
            setError(null);
          }}
        >
          <span>+</span>
          新消息
        </button>

        <nav className="nav-list" aria-label="Workspace navigation">
          <button type="button" className="nav-item">
            智能体
          </button>
          <button type="button" className="nav-item">
            能力
          </button>
          <button type="button" className="nav-item">
            应用授权
          </button>
        </nav>

        <section className="conversation-list">
          <p>会话</p>
          <button type="button" className="conversation active">
            <span className="mini-mark">V</span>
            当前会话
          </button>
          {messages
            .filter((message) => message.role === "user")
            .slice(-6)
            .map((message) => (
              <button key={message.id} type="button" className="conversation">
                {message.content}
              </button>
            ))}
        </section>

        <footer className="sidebar-footer">
          <div className="avatar">J</div>
          <div>
            <strong>Johnny Wei</strong>
            <p>{profile?.name ?? "Default"} profile</p>
          </div>
        </footer>
      </aside>

      <main className="chat-main">
        <header className="chat-header">
          <div>
            <p className="eyebrow">Agent Chat</p>
            <h1>{selectedAgent?.name ?? "Vulture"}</h1>
          </div>
          <div className="auth-actions">
            <span className={`auth-pill ${authStatus?.configured ? "ready" : ""}`}>
              {authLabel(authStatus)}
            </span>
            <button
              type="button"
              onClick={() => startCodexLogin(Boolean(codexAuthenticated))}
              disabled={codexLoginStatus === "starting" || codexLoginStatus === "waiting"}
            >
              {codexLoginStatus === "starting"
                ? "Opening..."
                : codexLoginStatus === "waiting"
                  ? "Waiting..."
                  : codexAuthenticated
                    ? "Re-authorize"
                    : "Login with Codex"}
            </button>
            <button
              type="button"
              onClick={refreshAuthStatus}
              disabled={authRefreshStatus === "refreshing"}
            >
              Refresh
            </button>
          </div>
        </header>

        <section className={`chat-stage ${messages.length ? "has-messages" : ""}`}>
          {messages.length ? (
            <div className="message-list">
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <div className="message-avatar">{message.role === "user" ? "J" : "V"}</div>
                  <div className="message-bubble">
                    <pre>{message.content}</pre>
                  </div>
                </article>
              ))}
              {status === "running" ? (
                <article className="message assistant">
                  <div className="message-avatar">V</div>
                  <div className="message-bubble muted-bubble">正在处理...</div>
                </article>
              ) : null}
            </div>
          ) : (
            <div className="empty-state">
              <div className="hero-mark">V</div>
              <h2>Vulture</h2>
              <p>选择智能体，然后直接输入任务。</p>
              <p>每个智能体都有独立工作区，运行时自动使用当前智能体的 workspace。</p>
              <div className="starter-grid">
                {starterPrompts.map((prompt) => (
                  <button key={prompt} type="button" onClick={() => setTaskInput(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="composer-wrap">
          {error ? <p className="error">{error}</p> : null}
          {codexLogin && !codexLogin.alreadyAuthenticated ? (
            <div className="code-box">
              <span>Codex code</span>
              <strong>{codexLogin.userCode}</strong>
            </div>
          ) : null}
          <div className="composer">
            <textarea
              value={taskInput}
              placeholder="输入问题...（@ 引用文件）"
              onChange={(event) => setTaskInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <div className="composer-controls">
              <button type="button" aria-label="Attach file">
                +
              </button>
              <select value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={sendMockMessage} disabled={status === "running"}>
                Mock
              </button>
              <button type="button" className="send-button" onClick={sendMessage} disabled={!canSend}>
                ↑
              </button>
            </div>
          </div>
          <div className="run-meta">
            <span>{selectedAgent?.workspace.path ?? "未选择智能体工作区"}</span>
            <span>状态：{status}</span>
            {events.length ? <span>{events.length} events</span> : null}
          </div>
          <div className="api-key-row">
            <input
              type="password"
              value={apiKeyInput}
              placeholder="可选：输入 OpenAI API key"
              onChange={(event) => setApiKeyInput(event.target.value)}
            />
            <button type="button" onClick={saveApiKey} disabled={!apiKeyInput.trim()}>
              Save Key
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function assistantTextFromEvents(events: RunEvent[]) {
  const completed = [...events].reverse().find((event) => event.type === "run_completed");
  const finalOutput = completed?.payload.finalOutput;
  if (typeof finalOutput === "string" && finalOutput.trim()) {
    return finalOutput.trim();
  }

  if (!events.length) return "任务完成，但没有返回内容。";

  return events
    .map((event) => `${event.type}\n${JSON.stringify(event.payload, null, 2)}`)
    .join("\n\n");
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function isTauriUnavailable(cause: unknown) {
  return errorMessage(cause).includes("invoke");
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
