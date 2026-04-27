export interface SseFrame {
  id: string;
  event: string;
  data: string;
}

export interface SseStreamOptions {
  url: string;
  token: string;
  lastEventId?: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}

export class SseError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SseError";
    this.status = status;
  }
}

export function parseFrame(raw: string): SseFrame {
  let id = "";
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value =
      colon === -1 ? "" : line[colon + 1] === " " ? line.slice(colon + 2) : line.slice(colon + 1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  return { id, event, data: dataLines.join("\n") };
}

export async function* sseStream(opts: SseStreamOptions): AsyncGenerator<SseFrame, void, unknown> {
  const f = opts.fetch ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "text/event-stream",
  };
  if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;

  const res = await f(opts.url, { headers, signal: opts.signal });
  if (!res.ok) throw new SseError(`SSE HTTP ${res.status}`, res.status);
  if (!res.body) return;

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim().length > 0) yield parseFrame(buffer);
        return;
      }
      buffer += value;
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        yield parseFrame(frame);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort cleanup
    }
  }
}
