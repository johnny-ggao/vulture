import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import type { BrowserRelayStatus } from "./browserTypes";
import type {
  AgentToolName,
  AgentView,
  CodexLoginRequest,
  CodexLoginStart,
  OpenAiAuthStatus,
  SaveWorkspaceRequest,
  WorkspaceView,
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

const agentTools: AgentToolName[] = ["shell.exec", "browser.snapshot", "browser.click"];

function authLabel(status: OpenAiAuthStatus | null) {
  if (!status?.configured) return "API key or Codex login missing";
  if (status.source === "codex") return "Configured via Codex ChatGPT login";
  if (status.source === "environment") return "Configured via OPENAI_API_KEY";
  return "Configured via Keychain API key";
}

const agentTemplates: Record<"local" | "coder" | "browser", AgentView> = {
  local: {
    id: "local-work-agent",
    name: "Local Work Agent",
    description: "General local work assistant",
    model: "gpt-5.4",
    reasoning: "medium",
    tools: ["shell.exec", "browser.snapshot", "browser.click"],
    instructions:
      "You are Vulture's local work agent. Request local actions through tools and never claim a local command ran unless a tool result confirms it.",
  },
  coder: {
    id: "coder",
    name: "Coder",
    description: "Focused coding assistant",
    model: "gpt-5.4",
    reasoning: "medium",
    tools: ["shell.exec"],
    instructions: "You are a careful coding agent. Explain changes briefly and verify them.",
  },
  browser: {
    id: "browser-researcher",
    name: "Browser Researcher",
    description: "Research assistant using browser tools",
    model: "gpt-5.4",
    reasoning: "medium",
    tools: ["browser.snapshot", "browser.click"],
    instructions: "You inspect browser context and summarize findings clearly.",
  },
};

export function App() {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [authStatus, setAuthStatus] = useState<OpenAiAuthStatus | null>(null);
  const [codexLogin, setCodexLogin] = useState<CodexLoginStart | null>(null);
  const [codexLoginStatus, setCodexLoginStatus] = useState("idle");
  const [authRefreshStatus, setAuthRefreshStatus] = useState("idle");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState<SaveWorkspaceRequest>({
    id: "vulture",
    name: "Vulture",
    path: "/Users/johnny/Work/vulture",
  });
  const [taskInput, setTaskInput] = useState("Summarize this workspace");
  const [browserStatus, setBrowserStatus] = useState<BrowserRelayStatus | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const isRunning = useRef(false);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const canRun =
    Boolean(selectedAgent && selectedWorkspace && taskInput.trim() && authStatus?.configured) &&
    status !== "running";
  const codexAuthenticated = authStatus?.source === "codex" || codexLogin?.alreadyAuthenticated;

  useEffect(() => {
    let isMounted = true;

    async function loadCommandCenter() {
      try {
        const [profileResult, agentList, workspaceList, nextAuthStatus, nextBrowserStatus] =
          await Promise.all([
            invoke<Profile>("get_profile"),
            invoke<AgentView[]>("list_agents"),
            invoke<WorkspaceView[]>("list_workspaces"),
            invoke<OpenAiAuthStatus>("get_openai_auth_status"),
            invoke<BrowserRelayStatus>("get_browser_status"),
          ]);

        if (!isMounted) return;
        setProfile(profileResult);
        setAgents(agentList);
        setWorkspaces(workspaceList);
        setAuthStatus(nextAuthStatus);
        setBrowserStatus(nextBrowserStatus);
        setSelectedAgentId((current) => current || agentList[0]?.id || "");
        setSelectedWorkspaceId((current) => current || workspaceList[0]?.id || "");
      } catch (cause) {
        if (isMounted) {
          setError(errorMessage(cause));
        }
      }
    }

    loadCommandCenter();

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
        // Keep polling; the explicit error path is handled by the button action.
      }
      if (checks >= 80) {
        setCodexLoginStatus("idle");
        window.clearInterval(interval);
      }
    }, 3000);

    return () => window.clearInterval(interval);
  }, [codexLoginStatus]);

  function replaceAgent(nextAgent: AgentView) {
    setAgents((current) => {
      const rest = current.filter((agent) => agent.id !== nextAgent.id);
      return [...rest, nextAgent].sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  function updateSelectedAgent(patch: Partial<AgentView>) {
    if (!selectedAgent) return;
    const nextAgent = { ...selectedAgent, ...patch };
    setAgents((current) => {
      const rest = current.filter(
        (agent) => agent.id !== selectedAgent.id && agent.id !== nextAgent.id,
      );
      return [...rest, nextAgent].sort((left, right) => left.name.localeCompare(right.name));
    });
    if (patch.id) {
      setSelectedAgentId(patch.id);
    }
  }

  function toggleTool(tool: AgentToolName) {
    if (!selectedAgent) return;
    const tools = selectedAgent.tools.includes(tool)
      ? selectedAgent.tools.filter((item) => item !== tool)
      : [...selectedAgent.tools, tool];
    updateSelectedAgent({ tools });
  }

  async function saveSelectedAgent(nextAgent = selectedAgent) {
    if (!nextAgent) return;
    setError(null);

    try {
      const saved = await invoke<AgentView>("save_agent", { request: nextAgent });
      replaceAgent(saved);
      setSelectedAgentId(saved.id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function createAgentFromTemplate(template: keyof typeof agentTemplates) {
    await saveSelectedAgent(agentTemplates[template]);
  }

  async function saveWorkspace() {
    setError(null);

    try {
      const saved = await invoke<WorkspaceView>("save_workspace", { request: workspaceDraft });
      setWorkspaces((current) => {
        const rest = current.filter((workspace) => workspace.id !== saved.id);
        return [...rest, saved].sort((left, right) => left.name.localeCompare(right.name));
      });
      setSelectedWorkspaceId(saved.id);
    } catch (cause) {
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

  async function clearApiKey() {
    setError(null);

    try {
      const result = await invoke<OpenAiAuthStatus>("clear_openai_api_key");
      setAuthStatus(result);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

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

  async function startRealRun() {
    if (isRunning.current || !selectedAgent || !selectedWorkspace) return;

    isRunning.current = true;
    setStatus("running");
    setError(null);
    setEvents([]);

    try {
      const result = await invoke<RunEvent[]>("start_agent_run", {
        request: {
          agentId: selectedAgent.id,
          workspaceId: selectedWorkspace.id,
          input: taskInput,
        },
      });
      setEvents(result);
      setStatus("completed");
    } catch (cause) {
      setStatus("failed");
      setError(errorMessage(cause));
    } finally {
      isRunning.current = false;
    }
  }

  async function startMockRun() {
    if (isRunning.current) return;

    isRunning.current = true;
    setStatus("running");
    setError(null);
    setEvents([]);

    try {
      const result = await invoke<RunEvent[]>("start_mock_run", {
        input: taskInput || "Summarize this workspace",
      });
      setEvents(result);
      setStatus("completed");
    } catch (cause) {
      setStatus("failed");
      setError(errorMessage(cause));
    } finally {
      isRunning.current = false;
    }
  }

  async function startPairing() {
    setBrowserError(null);

    try {
      const result = await invoke<BrowserRelayStatus>("start_browser_pairing");
      setBrowserStatus(result);
    } catch (cause) {
      setBrowserError(errorMessage(cause));
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1>Vulture</h1>
        <p className="muted">{profile?.name ?? "Default"} profile</p>

        <section className="stack">
          <h2>Agents</h2>
          <div className="button-row">
            <button type="button" onClick={() => createAgentFromTemplate("local")}>
              Local
            </button>
            <button type="button" onClick={() => createAgentFromTemplate("coder")}>
              Coder
            </button>
            <button type="button" onClick={() => createAgentFromTemplate("browser")}>
              Browser
            </button>
          </div>
          <select value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </section>

        <section className="stack">
          <h2>Workspaces</h2>
          <select
            value={selectedWorkspaceId}
            onChange={(event) => setSelectedWorkspaceId(event.target.value)}
          >
            <option value="">No workspace</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          {selectedWorkspace ? <p className="path">{selectedWorkspace.path}</p> : null}
        </section>
      </aside>

      <main className="workspace">
        <header>
          <div>
            <p className="eyebrow">Command Center</p>
            <h2>{selectedAgent?.name ?? "Create an agent"}</h2>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => saveSelectedAgent()} disabled={!selectedAgent}>
              Save Agent
            </button>
            <button type="button" onClick={startRealRun} disabled={!canRun}>
              Run
            </button>
            <button type="button" onClick={startMockRun} disabled={status === "running"}>
              Mock
            </button>
          </div>
        </header>

        {selectedAgent ? (
          <section className="panel editor">
            <label>
              Agent ID
              <input
                value={selectedAgent.id}
                onChange={(event) => updateSelectedAgent({ id: event.target.value })}
              />
            </label>
            <label>
              Name
              <input
                value={selectedAgent.name}
                onChange={(event) => updateSelectedAgent({ name: event.target.value })}
              />
            </label>
            <label>
              Model
              <input
                value={selectedAgent.model}
                onChange={(event) => updateSelectedAgent({ model: event.target.value })}
              />
            </label>
            <label>
              Reasoning
              <select
                value={selectedAgent.reasoning}
                onChange={(event) => updateSelectedAgent({ reasoning: event.target.value })}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
            </label>
            <label className="wide">
              Description
              <input
                value={selectedAgent.description}
                onChange={(event) => updateSelectedAgent({ description: event.target.value })}
              />
            </label>
            <div className="wide tool-list">
              {agentTools.map((tool) => (
                <label key={tool} className="check">
                  <input
                    type="checkbox"
                    checked={selectedAgent.tools.includes(tool)}
                    onChange={() => toggleTool(tool)}
                  />
                  {tool}
                </label>
              ))}
            </div>
            <label className="wide">
              Instructions
              <textarea
                value={selectedAgent.instructions}
                onChange={(event) => updateSelectedAgent({ instructions: event.target.value })}
              />
            </label>
          </section>
        ) : null}

        <section className="panel run-panel">
          <label>
            Task
            <textarea value={taskInput} onChange={(event) => setTaskInput(event.target.value)} />
          </label>
          <p className="status">Run state: {status}</p>
          {error ? <p className="error">{error}</p> : null}
          <div className="timeline">
            {events.map((event, index) => (
              <article key={`${event.type}-${index}`} className="event">
                <strong>{event.type}</strong>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </article>
            ))}
          </div>
        </section>
      </main>

      <aside className="inspector">
        <section className="stack">
          <h2>OpenAI</h2>
          <p className="status">{authLabel(authStatus)}</p>
          {authStatus?.source === "codex" ? (
            <p className="muted">Run uses Codex CLI OAuth provider when no API key is saved.</p>
          ) : null}
          {authRefreshStatus === "refreshing" ? (
            <p className="muted">Refreshing authentication status...</p>
          ) : null}
          {codexLogin && !codexLogin.alreadyAuthenticated ? (
            <div className="code-box">
              <span>Codex code</span>
              <strong>{codexLogin.userCode}</strong>
            </div>
          ) : null}
          {codexLogin?.alreadyAuthenticated ? (
            <p className="muted">Codex is already authenticated.</p>
          ) : null}
          <input
            type="password"
            value={apiKeyInput}
            placeholder="sk-..."
            onChange={(event) => setApiKeyInput(event.target.value)}
          />
          <div className="button-row">
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
                    ? "Re-authorize Codex"
                    : "Login with Codex"}
            </button>
            <button
              type="button"
              onClick={refreshAuthStatus}
              disabled={authRefreshStatus === "refreshing"}
            >
              {authRefreshStatus === "refreshing" ? "Refreshing..." : "Refresh Auth"}
            </button>
            <button type="button" onClick={saveApiKey} disabled={!apiKeyInput.trim()}>
              Save Key
            </button>
            <button type="button" onClick={clearApiKey}>
              Clear
            </button>
          </div>
        </section>

        <section className="stack">
          <h2>Workspace</h2>
          <input
            value={workspaceDraft.id}
            onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, id: event.target.value })}
            placeholder="id"
          />
          <input
            value={workspaceDraft.name}
            onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, name: event.target.value })}
            placeholder="name"
          />
          <input
            value={workspaceDraft.path}
            onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, path: event.target.value })}
            placeholder="/absolute/path"
          />
          <button type="button" onClick={saveWorkspace}>
            Save Workspace
          </button>
        </section>

        <section className="stack">
          <h2>Browser</h2>
          <p className="status">
            {browserStatus?.paired
              ? "paired"
              : browserStatus?.enabled
                ? "pairing"
                : "disabled"}
          </p>
          {browserStatus?.relayPort ? <p>Relay: 127.0.0.1:{browserStatus.relayPort}</p> : null}
          {browserStatus?.pairingToken ? (
            <code className="token">{browserStatus.pairingToken}</code>
          ) : null}
          {browserError ? <p className="error">{browserError}</p> : null}
          <button type="button" onClick={startPairing}>
            Pair Extension
          </button>
        </section>
      </aside>
    </div>
  );
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
