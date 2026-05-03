import { describe, expect, test } from "bun:test";
import type { AgentInputItem, ModelRequest } from "@openai/agents";
import { makeAnthropicModelProvider } from "./anthropicModelProvider";

const REQUEST: ModelRequest = {
  input: "say hello",
  systemInstructions: "Be concise.",
  modelSettings: { maxTokens: 128 },
  tools: [],
  outputType: "text",
  handoffs: [],
  tracing: false,
};

async function collectStream(
  iter: AsyncIterable<unknown>,
): Promise<Array<{ type: string } & Record<string, unknown>>> {
  const out: Array<{ type: string } & Record<string, unknown>> = [];
  for await (const value of iter) {
    out.push(value as { type: string } & Record<string, unknown>);
  }
  return out;
}

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

const helloEvents = () =>
  sseResponse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_123",
          usage: { input_tokens: 7, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        usage: { output_tokens: 3 },
      },
    },
    {
      event: "message_stop",
      data: { type: "message_stop" },
    },
  ]);

describe("makeAnthropicModelProvider", () => {
  test("streams Anthropic Messages SSE as Agents model events", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedInit = init;
      return helloEvents();
    }) as typeof fetch;

    const provider = makeAnthropicModelProvider({
      apiKey: "sk-ant-test",
      baseUrl: "https://anthropic.test",
      fetch: fetchFn,
    });
    const model = await provider.getModel("claude-opus-test");
    const events = await collectStream(model.getStreamedResponse(REQUEST));

    expect(capturedUrl).toBe("https://anthropic.test/v1/messages");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "sk-ant-test",
    });
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe("claude-opus-test");
    expect(body.stream).toBe(true);
    expect(body.system).toBe("Be concise.");
    expect(body.max_tokens).toBe(128);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "say hello" }],
      },
    ]);
    expect(events.map((entry) => entry.type)).toEqual([
      "response_started",
      "output_text_delta",
      "response_done",
    ]);
    expect((events[1] as unknown as { delta: string }).delta).toBe("hello");
    const done = events[2] as unknown as {
      response: { id: string; usage: unknown; output: unknown };
    };
    expect(done.response.id).toBe("msg_123");
    expect(done.response.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      requests: 1,
    });
    expect(done.response.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello" }],
      },
    ]);
  });

  test("getResponse consumes streamed response and returns final model response", async () => {
    const provider = makeAnthropicModelProvider({
      apiKey: "sk-ant-test",
      fetch: (async () => helloEvents()) as unknown as typeof fetch,
    });
    const model = await provider.getModel();

    const response = await model.getResponse(REQUEST);

    expect(response.responseId).toBe("msg_123");
    expect(response.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      requests: 1,
    });
    expect(response.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello" }],
      },
    ]);
  });

  test("serializes basic AgentInputItem text messages", async () => {
    let capturedBody: unknown;
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return helloEvents();
    }) as typeof fetch;
    const provider = makeAnthropicModelProvider({ apiKey: "sk-ant-test", fetch: fetchFn });
    const model = await provider.getModel();
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "first" }],
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "second" }],
      },
    ] as AgentInputItem[];

    await collectStream(model.getStreamedResponse({ ...REQUEST, input }));

    expect(capturedBody).toMatchObject({
      model: "claude-sonnet-4.5",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "second" }] },
      ],
    });
  });

  test("throws useful error for non-ok Anthropic response", async () => {
    const provider = makeAnthropicModelProvider({
      apiKey: "sk-ant-test",
      fetch: (async () =>
        new Response("bad key", {
          status: 401,
          statusText: "Unauthorized",
        })) as unknown as typeof fetch,
    });
    const model = await provider.getModel();

    await expect(collectStream(model.getStreamedResponse(REQUEST))).rejects.toThrow(
      "Anthropic Messages API error 401 Unauthorized: bad key",
    );
  });
});
