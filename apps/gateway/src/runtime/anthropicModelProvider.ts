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

const DEFAULT_MODEL = "claude-sonnet-4.5";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicModelProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

type AnthropicRole = "user" | "assistant";

interface AnthropicMessage {
  role: AnthropicRole;
  content: Array<{ type: "text"; text: string }>;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicSsePayload {
  type?: string;
  message?: {
    id?: string;
    usage?: AnthropicUsage;
  };
  delta?: {
    type?: string;
    text?: string;
  };
  usage?: AnthropicUsage;
}

interface AnthropicStreamState {
  responseId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export function makeAnthropicModelProvider(
  opts: AnthropicModelProviderOptions,
): ModelProvider {
  return {
    getModel(modelName?: string): Model {
      return makeAnthropicModel({
        ...opts,
        modelName: modelName || DEFAULT_MODEL,
      });
    },
  };
}

function makeAnthropicModel(
  opts: AnthropicModelProviderOptions & { modelName: string },
): Model {
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
        throw new Error("Anthropic Messages API stream ended without response_done.");
      }
      return finalResponse;
    },

    async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
      const response = await f(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildMessagesBody(request, opts.modelName)),
        signal: request.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Anthropic Messages API error ${response.status} ${response.statusText}: ${body}`,
        );
      }

      if (!response.body) {
        throw new Error("Anthropic Messages API stream response did not include a body.");
      }

      const state: AnthropicStreamState = {
        responseId: "anthropic-message",
        text: "",
        inputTokens: 0,
        outputTokens: 0,
      };

      yield { type: "response_started" } as StreamEvent;

      for await (const payload of readSsePayloads(response.body)) {
        const event = handleAnthropicPayload(payload, state);
        if (!event) continue;
        yield event;
      }
    },
  };
}

function buildMessagesBody(request: ModelRequest, modelName: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelName,
    messages: messagesFromInput(request.input),
    max_tokens: request.modelSettings.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  };
  if (request.systemInstructions) {
    body.system = request.systemInstructions;
  }
  return body;
}

function messagesFromInput(input: ModelRequest["input"]): AnthropicMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input }] }];
  }

  const messages: AnthropicMessage[] = [];
  for (const item of input) {
    const role = roleFromItem(item);
    const text = textFromItem(item);
    if (!text) continue;
    messages.push({ role, content: [{ type: "text", text }] });
  }
  return messages.length > 0
    ? messages
    : [{ role: "user", content: [{ type: "text", text: "" }] }];
}

function roleFromItem(item: AgentInputItem): AnthropicRole {
  const role = (item as { role?: unknown }).role;
  return role === "assistant" ? "assistant" : "user";
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
): AsyncIterable<AnthropicSsePayload> {
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
): Iterable<AnthropicSsePayload> {
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

function parseSseBlock(block: string): AnthropicSsePayload | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as AnthropicSsePayload;
  } catch {
    return null;
  }
}

function handleAnthropicPayload(
  payload: AnthropicSsePayload,
  state: AnthropicStreamState,
): StreamEvent | null {
  if (payload.type === "message_start") {
    state.responseId = payload.message?.id || state.responseId;
    state.inputTokens = payload.message?.usage?.input_tokens ?? state.inputTokens;
    state.outputTokens = payload.message?.usage?.output_tokens ?? state.outputTokens;
    return null;
  }

  if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") {
    const delta = payload.delta.text ?? "";
    state.text += delta;
    return { type: "output_text_delta", delta } as StreamEvent;
  }

  if (payload.type === "message_delta") {
    state.outputTokens = payload.usage?.output_tokens ?? state.outputTokens;
    return null;
  }

  if (payload.type === "message_stop") {
    return {
      type: "response_done",
      response: {
        id: state.responseId,
        usage: usageFromState(state),
        output: outputFromText(state.text),
      },
    } as StreamEvent;
  }

  return null;
}

function usageFromState(state: AnthropicStreamState): Usage {
  return new Usage({
    requests: 1,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    totalTokens: state.inputTokens + state.outputTokens,
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
