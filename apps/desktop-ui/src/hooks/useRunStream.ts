import { useEffect, useReducer, useRef } from "react";
import type { ApiClient } from "../api/client";
import { sseStream } from "../api/sse";

// Permissive event shape — components type-narrow at the rendering boundary.
export type AnyRunEvent = {
  type: string;
  runId: string;
  seq: number;
  createdAt: string;
  [key: string]: unknown;
};

export type RunStreamStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunStreamState {
  status: RunStreamStatus;
  events: AnyRunEvent[];
  lastSeq: number;
  error: string | null;
}

export type RunStreamAction =
  | { type: "connect.start" }
  | { type: "connect.success" }
  | { type: "frame"; event: AnyRunEvent }
  | { type: "error"; error: string }
  | { type: "abort" };

const TERMINAL: RunStreamStatus[] = ["succeeded", "failed", "cancelled"];

function isTerminal(s: RunStreamStatus): boolean {
  return TERMINAL.includes(s);
}

export function runStreamReducer(state: RunStreamState, action: RunStreamAction): RunStreamState {
  switch (action.type) {
    case "connect.start":
      return { ...state, status: "connecting", error: null };
    case "connect.success":
      return { ...state, status: "streaming", error: null };
    case "frame": {
      if (isTerminal(state.status)) return state;
      if (action.event.seq <= state.lastSeq) return state;
      const events = [...state.events, action.event];
      let status: RunStreamStatus = "streaming";
      if (action.event.type === "run.completed") status = "succeeded";
      else if (action.event.type === "run.failed") status = "failed";
      else if (action.event.type === "run.cancelled") status = "cancelled";
      return { ...state, events, lastSeq: action.event.seq, status };
    }
    case "error":
      if (isTerminal(state.status)) return state;
      return { ...state, status: "reconnecting", error: action.error };
    case "abort":
      return { ...state, status: "cancelled" };
  }
}

export interface UseRunStreamOptions {
  client: ApiClient | null;
  runId: string | null;
  fetch?: typeof fetch;
}

export function useRunStream(opts: UseRunStreamOptions): RunStreamState {
  const [state, dispatch] = useReducer(runStreamReducer, {
    status: "idle",
    events: [],
    lastSeq: -1,
    error: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!opts.client || !opts.runId) return;
    const ac = new AbortController();
    let retry = 0;

    async function loop() {
      while (!ac.signal.aborted && !isTerminal(stateRef.current.status)) {
        dispatch({ type: "connect.start" });
        try {
          const url = `${opts.client!.base}/v1/runs/${opts.runId}/events`;
          for await (const frame of sseStream({
            url,
            token: opts.client!.token,
            lastEventId:
              stateRef.current.lastSeq >= 0 ? String(stateRef.current.lastSeq) : undefined,
            signal: ac.signal,
            fetch: opts.fetch,
          })) {
            if (retry === 0) dispatch({ type: "connect.success" });
            retry = 0;
            const parsed = JSON.parse(frame.data) as AnyRunEvent;
            dispatch({ type: "frame", event: parsed });
            if (isTerminal(stateRef.current.status)) return;
          }
          // stream ended cleanly without terminal event
          if (!isTerminal(stateRef.current.status)) {
            dispatch({ type: "error", error: "stream ended unexpectedly" });
          }
        } catch (cause) {
          if (ac.signal.aborted) return;
          dispatch({
            type: "error",
            error: cause instanceof Error ? cause.message : String(cause),
          });
          retry += 1;
          const backoff = Math.min(16_000, 1000 * 2 ** Math.min(retry, 4));
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    void loop();
    return () => ac.abort();
  }, [opts.client, opts.runId, opts.fetch]);

  return state;
}
