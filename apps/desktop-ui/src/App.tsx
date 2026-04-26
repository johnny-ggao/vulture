import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

type RunEvent = {
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
};

export function App() {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState("idle");

  async function startMockRun() {
    setStatus("running");
    const result = await invoke<RunEvent[]>("start_mock_run", {
      input: "Summarize this workspace",
    });
    setEvents(result);
    setStatus("completed");
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
          <button type="button" onClick={startMockRun}>
            Run Agent
          </button>
        </header>
        <section className="timeline">
          <p className="status">Run state: {status}</p>
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
