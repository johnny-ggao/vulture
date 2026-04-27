import { useEffect, useReducer, useRef } from "react";
import type { ApiClient } from "../api/client";
import { sseStream, type SseFrame } from "../api/sse";

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
  | { type: "reset" }
  | { type: "connect.start" }
  | { type: "connect.success" }
  | { type: "frame"; event: AnyRunEvent }
  | { type: "error"; error: string }
  | { type: "abort" };

const INITIAL_STATE: RunStreamState = {
  status: "idle",
  events: [],
  lastSeq: -1,
  error: null,
};

const TERMINAL: RunStreamStatus[] = ["succeeded", "failed", "cancelled"];

function isTerminal(s: RunStreamStatus): boolean {
  return TERMINAL.includes(s);
}

export function parseRunEventFrame(frame: SseFrame): AnyRunEvent | null {
  if (frame.event === "ping" || frame.data.trim().length === 0) return null;
  return JSON.parse(frame.data) as AnyRunEvent;
}

export function runStreamReducer(state: RunStreamState, action: RunStreamAction): RunStreamState {
  switch (action.type) {
    case "reset":
      return INITIAL_STATE;
    case "connect.start":
      if (isTerminal(state.status)) return state;
      return { ...state, status: "connecting", error: null };
    case "connect.success":
      if (isTerminal(state.status)) return state;
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
  const [state, dispatch] = useReducer(runStreamReducer, INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!opts.client || !opts.runId) {
      dispatch({ type: "reset" });
      return;
    }
    // Fresh state for each runId so a previous terminal status doesn't
    // short-circuit the next run's connection loop.
    dispatch({ type: "reset" });
    stateRef.current = INITIAL_STATE;
    const ac = new AbortController();
    let retry = 0;

    // Locally tracked terminal flag — synchronous, doesn't rely on React
    // committing the reducer state into stateRef before the loop checks again.
    let sawTerminal = false;

    async function loop() {
      while (!ac.signal.aborted && !sawTerminal && !isTerminal(stateRef.current.status)) {
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
            onOpen: () => {
              dispatch({ type: "connect.success" });
              retry = 0;
            },
          })) {
            const parsed = parseRunEventFrame(frame);
            if (!parsed) continue;
            dispatch({ type: "frame", event: parsed });
            if (
              parsed.type === "run.completed" ||
              parsed.type === "run.failed" ||
              parsed.type === "run.cancelled"
            ) {
              sawTerminal = true;
              return;
            }
          }
          if (sawTerminal || isTerminal(stateRef.current.status)) return;
          // stream ended cleanly without terminal event
          dispatch({ type: "error", error: "stream ended unexpectedly" });
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
