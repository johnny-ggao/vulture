import { describe, expect, test } from "bun:test";
import { parseFrame, sseStream } from "./sse";

describe("parseFrame", () => {
  test("parses standard frame", () => {
    expect(parseFrame("id: 5\nevent: text.delta\ndata: hello")).toEqual({
      id: "5",
      event: "text.delta",
      data: "hello",
    });
  });

  test("multiline data joined with newline", () => {
    expect(parseFrame("event: x\ndata: line1\ndata: line2").data).toBe("line1\nline2");
  });

  test("missing fields default to empty string", () => {
    expect(parseFrame("data: only-data")).toEqual({ id: "", event: "message", data: "only-data" });
  });

  test("ignores comment lines starting with :", () => {
    expect(parseFrame(": ping\nid: 1\nevent: e\ndata: d").event).toBe("e");
  });
});

function makeStreamResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("sseStream", () => {
  test("yields parsed frames in order", async () => {
    const fetchMock = (async () =>
      makeStreamResponse([
        "id: 0\nevent: run.started\ndata: {}\n\n",
        "id: 1\nevent: text.delta\ndata: hello\n\n",
      ])) as typeof fetch;
    const frames: Array<{ id: string; event: string }> = [];
    for await (const frame of sseStream({
      url: "/v1/runs/r/events",
      token: "tok",
      signal: new AbortController().signal,
      fetch: fetchMock,
    })) {
      frames.push({ id: frame.id, event: frame.event });
    }
    expect(frames).toEqual([
      { id: "0", event: "run.started" },
      { id: "1", event: "text.delta" },
    ]);
  });

  test("handles frames split across chunks", async () => {
    const fetchMock = (async () =>
      makeStreamResponse(["id: 0\nevent: a\ndata: ", "x\n", "\n"])) as typeof fetch;
    const frames: string[] = [];
    for await (const frame of sseStream({
      url: "/x",
      token: "t",
      signal: new AbortController().signal,
      fetch: fetchMock,
    })) {
      frames.push(frame.data);
    }
    expect(frames).toEqual(["x"]);
  });

  test("sends Last-Event-ID header when provided", async () => {
    let captured: Headers | undefined;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      captured = new Headers(init.headers);
      return makeStreamResponse([]);
    }) as typeof fetch;
    const iter = sseStream({
      url: "/x",
      token: "t",
      lastEventId: "5",
      signal: new AbortController().signal,
      fetch: fetchMock,
    });
    await iter.next();
    expect(captured?.get("Last-Event-ID")).toBe("5");
    expect(captured?.get("Authorization")).toBe("Bearer t");
  });

  test("calls onOpen after a successful response even when no frames arrive", async () => {
    let opened = false;
    const fetchMock = (async () => makeStreamResponse([])) as typeof fetch;
    const iter = sseStream({
      url: "/x",
      token: "t",
      signal: new AbortController().signal,
      fetch: fetchMock,
      onOpen: () => {
        opened = true;
      },
    });

    await iter.next();

    expect(opened).toBe(true);
  });

  test("does not call onOpen for non-2xx responses", async () => {
    let opened = false;
    const fetchMock = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const iter = sseStream({
      url: "/x",
      token: "t",
      signal: new AbortController().signal,
      fetch: fetchMock,
      onOpen: () => {
        opened = true;
      },
    });

    await expect(iter.next()).rejects.toThrow(/401/);
    expect(opened).toBe(false);
  });

  test("throws on non-2xx response", async () => {
    const fetchMock = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    const iter = sseStream({
      url: "/x",
      token: "t",
      signal: new AbortController().signal,
      fetch: fetchMock,
    });
    await expect(iter.next()).rejects.toThrow(/401/);
  });
});
