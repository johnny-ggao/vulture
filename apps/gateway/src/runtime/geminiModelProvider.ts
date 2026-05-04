import type {
  AgentInputItem,
  AgentOutputItem,
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "@openai/agents";
import { Usage } from "@openai/agents";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MAX_TOKENS = 4096;

export interface GeminiModelProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

type GeminiRole = "user" | "model";

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: GeminiRole;
  parts: GeminiPart[];
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiSsePayload {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
      role?: string;
    };
    finishReason?: string;
    index?: number;
  }>;
  usageMetadata?: GeminiUsage;
  modelVersion?: string;
  responseId?: string;
}

interface GeminiStreamState {
  responseId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function makeGeminiModelProvider(opts: GeminiModelProviderOptions): ModelProvider {
  return {
    getModel(modelName?: string): Model {
      return makeGeminiModel({
        ...opts,
        modelName: modelName || DEFAULT_MODEL,
      });
    },
  };
}

function makeGeminiModel(opts: GeminiModelProviderOptions & { modelName: string }): Model {
  const f = opts.fetch ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      let finalResponse: ModelResponse | undefined;
      for await (const event of this.getStreamedResponse(request)) {
        if (event.type === "response_done") {
          finalResponse = {
            usage: event.response.usage as Usage,
            output: event.response.output as AgentOutputItem[],
            responseId: event.response.id,
            requestId: event.response.requestId,
            providerData: event.response.providerData,
          };
        }
      }
      if (!finalResponse) {
        throw new Error("Gemini API stream ended without response_done.");
      }
      return finalResponse;
    },

    async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
      const url =
        `${baseUrl}/v1beta/models/${encodeURIComponent(opts.modelName)}:streamGenerateContent` +
        `?alt=sse&key=${encodeURIComponent(opts.apiKey)}`;
      const response = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildGenerateBody(request, opts.modelName)),
        signal: request.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Gemini API error ${response.status} ${response.statusText}: ${body}`,
        );
      }

      if (!response.body) {
        throw new Error("Gemini API stream response did not include a body.");
      }

      const state: GeminiStreamState = {
        responseId: "gemini-response",
        text: "",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };

      yield { type: "response_started" } as StreamEvent;

      for await (const payload of readSsePayloads(response.body)) {
        for (const event of handleGeminiPayload(payload, state)) {
          yield event;
        }
      }

      yield {
        type: "response_done",
        response: {
          id: state.responseId,
          usage: usageFromState(state),
          output: outputFromText(state.text),
        },
      } as StreamEvent;
    },
  };
}

function buildGenerateBody(request: ModelRequest, _modelName: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: contentsFromInput(request.input),
    generationConfig: {
      maxOutputTokens: request.modelSettings.maxTokens ?? DEFAULT_MAX_TOKENS,
    },
  };
  if (request.systemInstructions) {
    body.systemInstruction = { parts: [{ text: request.systemInstructions }] };
  }
  return body;
}

function contentsFromInput(input: ModelRequest["input"]): GeminiContent[] {
  if (typeof input === "string") {
    return [{ role: "user", parts: [{ text: input }] }];
  }

  const contents: GeminiContent[] = [];
  for (const item of input) {
    const role = roleFromItem(item);
    const text = textFromItem(item);
    if (!text) continue;
    contents.push({ role, parts: [{ text }] });
  }
  return contents.length > 0
    ? contents
    : [{ role: "user", parts: [{ text: "" }] }];
}

function roleFromItem(item: AgentInputItem): GeminiRole {
  const role = (item as { role?: unknown }).role;
  return role === "assistant" ? "model" : "user";
}

function textFromItem(item: AgentInputItem): string {
  const content = (item as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(textFromContentPart).filter(Boolean).join("");
  }
  return stableStringify(item);
}

function textFromContentPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return stableStringify(part);

  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.refusal === "string") return record.refusal;
  return stableStringify(record);
}

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function* readSsePayloads(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<GeminiSsePayload> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drainSseBuffer(buffer, (remaining) => {
        buffer = remaining;
      });
    }
    buffer += decoder.decode();
    yield* drainSseBuffer(buffer, (remaining) => {
      buffer = remaining;
    });
    if (buffer.trim()) {
      const payload = parseSseBlock(buffer);
      if (payload) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

function* drainSseBuffer(
  buffer: string,
  setRemaining: (remaining: string) => void,
): Iterable<GeminiSsePayload> {
  let remaining = buffer;
  let boundary = remaining.indexOf("\n\n");
  while (boundary !== -1) {
    const block = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + 2);
    const payload = parseSseBlock(block);
    if (payload) yield payload;
    boundary = remaining.indexOf("\n\n");
  }
  setRemaining(remaining);
}

function parseSseBlock(block: string): GeminiSsePayload | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as GeminiSsePayload;
  } catch {
    return null;
  }
}

function* handleGeminiPayload(
  payload: GeminiSsePayload,
  state: GeminiStreamState,
): Iterable<StreamEvent> {
  if (typeof payload.responseId === "string" && payload.responseId.length > 0) {
    state.responseId = payload.responseId;
  }
  if (payload.usageMetadata) {
    if (typeof payload.usageMetadata.promptTokenCount === "number") {
      state.inputTokens = payload.usageMetadata.promptTokenCount;
    }
    if (typeof payload.usageMetadata.candidatesTokenCount === "number") {
      state.outputTokens = payload.usageMetadata.candidatesTokenCount;
    }
    if (typeof payload.usageMetadata.totalTokenCount === "number") {
      state.totalTokens = payload.usageMetadata.totalTokenCount;
    }
  }

  const candidates = payload.candidates ?? [];
  for (const candidate of candidates) {
    const parts = candidate.content?.parts ?? [];
    for (const part of parts) {
      const delta = typeof part.text === "string" ? part.text : "";
      if (!delta) continue;
      state.text += delta;
      yield { type: "output_text_delta", delta } as StreamEvent;
    }
  }
}

function usageFromState(state: GeminiStreamState): Usage {
  const total = state.totalTokens > 0
    ? state.totalTokens
    : state.inputTokens + state.outputTokens;
  return new Usage({
    requests: 1,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    totalTokens: total,
  });
}

function outputFromText(text: string): AgentOutputItem[] {
  if (!text) return [];
  return [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    } as AgentOutputItem,
  ];
}
