import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { makeGeminiModelProvider } from "./geminiModelProvider";

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

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
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
      candidates: [
        {
          content: { role: "model", parts: [{ text: "hel" }] },
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, totalTokenCount: 8 },
      modelVersion: "gemini-2.0-flash",
      responseId: "gen-abc",
    },
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "lo" }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
    },
  ]);

describe("makeGeminiModelProvider", () => {
  test("streams Gemini SSE candidates as Agents text deltas", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedInit = init;
      return helloEvents();
    }) as typeof fetch;

    const provider = makeGeminiModelProvider({
      apiKey: "AIzaXYZ",
      fetch: fetchFn,
    });

    const model = await provider.getModel();
    const events = await collectStream(model.getStreamedResponse(REQUEST));

    expect(capturedUrl).toContain(
      "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
    );
    expect(capturedUrl).toContain("alt=sse");
    expect(capturedUrl).toContain("key=AIzaXYZ");
    expect(capturedInit?.method).toBe("POST");
    const body = JSON.parse(String(capturedInit?.body ?? "{}"));
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "say hello" }] }]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be concise." }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 128 });

    const textDeltas = events.filter((e) => e.type === "output_text_delta");
    expect(textDeltas.map((e) => (e as unknown as { delta: string }).delta)).toEqual(["hel", "lo"]);

    const done = events.find((e) => e.type === "response_done") as
      | { response: { id: string; usage: { totalTokens: number; inputTokens: number } } }
      | undefined;
    expect(done?.response.id).toBe("gen-abc");
    expect(done?.response.usage.inputTokens).toBe(7);
    expect(done?.response.usage.totalTokens).toBe(9);
  });

  test("uses overridden model name when provided", async () => {
    let capturedUrl = "";
    const fetchFn = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return helloEvents();
    }) as typeof fetch;

    const provider = makeGeminiModelProvider({
      apiKey: "AIzaXYZ",
      fetch: fetchFn,
    });

    const model = await provider.getModel("gemini-2.5-flash");
    await collectStream(model.getStreamedResponse(REQUEST));
    expect(capturedUrl).toContain("/v1beta/models/gemini-2.5-flash:streamGenerateContent");
  });

  test("getResponse returns a buffered ModelResponse", async () => {
    const fetchFn = (async () => helloEvents()) as unknown as typeof fetch;
    const provider = makeGeminiModelProvider({
      apiKey: "AIzaXYZ",
      fetch: fetchFn,
    });
    const model = await provider.getModel();
    const response = await model.getResponse(REQUEST);
    expect(response.responseId).toBe("gen-abc");
    const message = response.output[0] as { content: Array<{ type: string; text: string }> };
    expect(message.content[0].text).toBe("hello");
  });

  test("non-2xx response surfaces the upstream status text", async () => {
    const fetchFn = (async () =>
      new Response("forbidden", { status: 403, statusText: "Forbidden" })) as unknown as typeof fetch;
    const provider = makeGeminiModelProvider({ apiKey: "AIzaXYZ", fetch: fetchFn });
    const model = await provider.getModel();
    await expect(collectStream(model.getStreamedResponse(REQUEST))).rejects.toThrow(
      /Gemini API error 403 Forbidden/,
    );
  });
});
