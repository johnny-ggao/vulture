import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import type { BrowserRelayStatus } from "./browserTypes";

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

export function App() {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [browserStatus, setBrowserStatus] = useState<BrowserRelayStatus | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const isRunning = useRef(false);

  useEffect(() => {
    let isMounted = true;

    invoke<Profile>("get_profile")
      .then((result) => {
        if (isMounted) {
          setProfile(result);
        }
      })
      .catch(() => {
        if (isMounted) {
          setProfile(null);
        }
      });

    invoke<BrowserRelayStatus>("get_browser_status")
      .then((result) => {
        if (isMounted) {
          setBrowserStatus(result);
        }
      })
      .catch(() => {
        if (isMounted) {
          setBrowserStatus(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  async function startPairing() {
    setBrowserError(null);

    try {
      const result = await invoke<BrowserRelayStatus>("start_browser_pairing");
      setBrowserStatus(result);
    } catch (cause) {
      setBrowserError(errorMessage(cause));
    }
  }

  async function startMockRun() {
    if (isRunning.current) return;

    isRunning.current = true;
    setStatus("running");
    setError(null);

    let nextStatus = "completed";
    try {
      const result = await invoke<RunEvent[]>("start_mock_run", {
        input: "Summarize this workspace",
      });
      setEvents(result);
    } catch (cause) {
      nextStatus = "failed";
      setError(errorMessage(cause));
    } finally {
      isRunning.current = false;
      setStatus(nextStatus);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1>Vulture</h1>
        <button type="button">{profile?.name ?? "Default Profile"}</button>
        <button type="button">{profile?.activeAgentId ?? "Local Work Agent"}</button>
      </aside>
      <main className="workspace">
        <header>
          <div>
            <p className="eyebrow">Workspace</p>
            <h2>Local Agent Workbench</h2>
          </div>
          <button type="button" onClick={startMockRun} disabled={status === "running"}>
            Run Agent
          </button>
        </header>
        <section className="timeline">
          <p className="status">Run state: {status}</p>
          {error ? <p className="error">{error}</p> : null}
          {events.map((event, index) => (
            <article key={`${event.type}-${index}`} className="event">
              <strong>{event.type}</strong>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </article>
          ))}
        </section>
      </main>
      <aside className="inspector">
        <h2>Browser</h2>
        <p>
          Status:{" "}
          {browserStatus?.paired ? "paired" : browserStatus?.enabled ? "pairing" : "disabled"}
        </p>
        {browserStatus?.relayPort ? <p>Relay: 127.0.0.1:{browserStatus.relayPort}</p> : null}
        {browserStatus?.pairingToken ? (
          <code className="token">{browserStatus.pairingToken}</code>
        ) : null}
        {browserError ? <p className="error">{browserError}</p> : null}
        <button type="button" onClick={startPairing}>
          Pair Extension
        </button>
      </aside>
    </div>
  );
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
