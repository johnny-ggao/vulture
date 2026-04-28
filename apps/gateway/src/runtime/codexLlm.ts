import OpenAI from "openai";
import type { LlmCallable, LlmYield, ToolCallable } from "@vulture/agent-runtime";
import { makeOpenAILlm, makeResponsesModelProvider, type OpenAILlmOptions } from "./openaiLlm";

export interface CodexShellResponse {
  accessToken: string;
  accountId: string;
  expiresAt: number;
  email?: string;
}

export class CodexShellError extends Error {
  constructor(
    message: string,
    public readonly code: "auth.codex_not_signed_in" | "auth.codex_expired" | "internal",
    public readonly status: number,
  ) {
    super(message);
    this.name = "CodexShellError";
  }
}

export interface FetchCodexTokenOptions {
  shellUrl: string;
  bearer: string;
  fetch?: typeof fetch;
}

export async function fetchCodexToken(opts: FetchCodexTokenOptions): Promise<CodexShellResponse> {
  const f = opts.fetch ?? fetch;
  const headers = { Authorization: `Bearer ${opts.bearer}` };

  const first = await f(`${opts.shellUrl}/auth/codex`, { headers });
  if (first.ok) {
    return (await first.json()) as CodexShellResponse;
  }
  if (first.status === 404) {
    const body = (await first.json().catch(() => ({}))) as { code?: string; message?: string };
    throw makeShellError(body.code ?? "internal", first.status, body.message ?? "not signed in");
  }
  if (first.status === 401) {
    const refresh = await f(`${opts.shellUrl}/auth/codex/refresh`, {
      method: "POST",
      headers,
    });
    if (refresh.ok) {
      const second = await f(`${opts.shellUrl}/auth/codex`, { headers });
      if (second.ok) {
        return (await second.json()) as CodexShellResponse;
      }
      const body = (await second.json().catch(() => ({}))) as { code?: string; message?: string };
      throw makeShellError(body.code ?? "auth.codex_expired", second.status, body.message ?? "expired after refresh");
    }
    const body = (await refresh.json().catch(() => ({}))) as { code?: string; message?: string };
    throw makeShellError(body.code ?? "auth.codex_expired", refresh.status, body.message ?? "refresh failed");
  }
  const body = (await first.json().catch(() => ({}))) as { code?: string; message?: string };
  throw makeShellError(body.code ?? "internal", first.status, body.message ?? "unknown shell error");
}

function makeShellError(code: string, status: number, message: string): CodexShellError {
  return new CodexShellError(message, code as CodexShellError["code"], status);
}

export interface CodexLlmOptions {
  shellUrl: string;
  shellBearer: string;
  toolNames: readonly string[];
  toolCallable: ToolCallable;
  fetch?: typeof fetch;
  codexToken?: CodexShellResponse;
  runFactory?: OpenAILlmOptions["runFactory"];
  approvalCallable?: OpenAILlmOptions["approvalCallable"];
  mcpToolProvider?: OpenAILlmOptions["mcpToolProvider"];
}

/**
 * Wraps fetch so the chatgpt.com/backend-api/codex SSE stream is patched on
 * the fly: items reported via `response.output_item.done` are buffered and
 * injected into the `response.completed` event's `response.output[]` array
 * (which the codex backend ships empty). Without this, @openai/agents'
 * runner sees no assistant message in the response and loops until it
 * exceeds maxTurns.
 */
export function makeCodexResponsesFetch(baseFetch?: typeof fetch): typeof fetch {
  const f = baseFetch ?? fetch;
  return (async (input, init) => {
    const upstream = await f(input, init);
    // Codex backend doesn't set Content-Type on SSE responses, so we can't
    // gate on header. Apply transformer to any successful body — non-SSE
    // bodies pass through unchanged because they don't contain
    // `output_item.done` / `response.completed` events.
    if (!upstream.ok || !upstream.body) {
      return upstream;
    }
    const transformed = upstream.body.pipeThrough(makeCodexSseTransformer());
    return new Response(transformed, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }) as typeof fetch;
}

interface CodexResponseItem {
  id?: string;
  type?: string;
  [k: string]: unknown;
}

function makeCodexSseTransformer(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const items: CodexResponseItem[] = [];
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const out = transformBlock(block, items);
        controller.enqueue(encoder.encode(out + "\n\n"));
        boundary = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(transformBlock(buffer, items)));
      }
    },
  });
}

function transformBlock(block: string, items: CodexResponseItem[]): string {
  const lines = block.split("\n");
  const dataLine = lines.find((l) => l.startsWith("data:"));
  const eventLine = lines.find((l) => l.startsWith("event:"));
  if (!dataLine) return block;
  const eventType = eventLine?.slice("event:".length).trim();
  const payload = dataLine.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return block;
  let parsed: { type?: string; item?: CodexResponseItem; response?: { output?: unknown[] } };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return block;
  }
  // Buffer items from output_item.done. Skip reasoning items: their
  // encrypted_content is not echoed by chatgpt.com/backend-api/codex, so
  // the SDK cannot replay them on the next turn (backend returns 404
  // because store=false). Dropping them here means the SDK won't include
  // them in the next turn's input, which keeps multi-turn flows working.
  if (parsed.type === "response.output_item.done" && parsed.item) {
    if (parsed.item.type !== "reasoning") {
      items.push(parsed.item);
    }
    return block;
  }
  // On the terminal completed event, inject buffered items if backend's
  // output[] is empty.
  const isTerminal =
    eventType === "response.completed" || parsed.type === "response.completed";
  if (isTerminal && parsed.response && Array.isArray(parsed.response.output)) {
    if (parsed.response.output.length === 0 && items.length > 0) {
      parsed.response.output = items.slice();
      const newPayload = JSON.stringify(parsed);
      return `${eventLine ? eventLine + "\n" : ""}data: ${newPayload}`;
    }
  }
  return block;
}

export function makeCodexLlm(opts: CodexLlmOptions): LlmCallable {
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    const token =
      opts.codexToken ??
      (await fetchCodexToken({
        shellUrl: opts.shellUrl,
        bearer: opts.shellBearer,
        fetch: opts.fetch,
      }));

    // Configure this run's provider to route via chatgpt.com/backend-api/codex
    // (the only path that accepts ChatGPT-subscription tokens). The SDK
    // appends "/responses", landing on the right endpoint. This is deliberately
    // passed to Runner as a per-run modelProvider by openaiLlm.ts; no global SDK
    // client mutation is needed.
    //
    // `originator: "codex_cli_rs"` is the only originator the backend allows
    // for ChatGPT-subscription auth — other values return 403.
    const client = new OpenAI({
      apiKey: token.accessToken,
      baseURL: "https://chatgpt.com/backend-api/codex",
      defaultHeaders: {
        "OpenAI-Beta": "responses=experimental",
        "chatgpt-account-id": token.accountId,
        originator: "codex_cli_rs",
        session_id: input.runId,
        conversation_id: input.runId,
      },
      // chatgpt.com/backend-api/codex emits `response.completed` with
      // `output: []` even when items came through earlier `output_item.done`
      // events. The SDK reads `response.completed.output[]` to decide if
      // there's a final assistant message; an empty array sends the runner
      // into infinite re-loop. Buffer items locally and inject them back.
      fetch: makeCodexResponsesFetch(opts.fetch),
      dangerouslyAllowBrowser: true,
    });

    // Delegate to existing OpenAILlm machinery with an explicit provider.
    // apiKey here is unused on the wire because the provider owns the client,
    // but makeOpenAILlm keeps it for API-key callers.
    const inner = makeOpenAILlm({
      apiKey: token.accessToken,
      toolNames: opts.toolNames,
      toolCallable: opts.toolCallable,
      modelProvider: makeResponsesModelProvider({ openAIClient: client }),
      runFactory: opts.runFactory,
      approvalCallable: opts.approvalCallable,
      mcpToolProvider: opts.mcpToolProvider,
    });
    yield* inner(input);
  };
}
