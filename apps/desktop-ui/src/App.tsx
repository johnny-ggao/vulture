import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";

type RunEvent = {
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
};

export function App() {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const isRunning = useRef(false);

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
        <button type="button">Default Profile</button>
        <button type="button">Local Work Agent</button>
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
        <h2>Approvals</h2>
        <p>No pending approvals.</p>
      </aside>
    </div>
  );
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
