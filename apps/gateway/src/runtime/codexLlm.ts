/**
 * Codex (ChatGPT subscription) LLM provider.
 *
 * IMPORTANT — SDK state contract:
 * Calling `makeCodexLlm` mutates @openai/agents global SDK state via
 * `setDefaultOpenAIClient`, `setOpenAIAPI("responses")`, and
 * `setTracingDisabled(true)`. These are PROCESS-GLOBAL side effects.
 *
 * Once a codex run executes, subsequent runs through other providers
 * (e.g. API key) MUST reset the SDK client to a vanilla OpenAI instance
 * before delegating, otherwise their requests will be routed to
 * chatgpt.com/backend-api with codex headers (401/404).
 *
 * `runtime/resolveLlm.ts` is responsible for enforcing this invariant.
 */
import OpenAI from "openai";
import { setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled } from "@openai/agents";
import type { LlmCallable, LlmYield, ToolCallable } from "@vulture/agent-runtime";
import { makeOpenAILlm } from "./openaiLlm";

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
}

export function makeCodexLlm(opts: CodexLlmOptions): LlmCallable {
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    const token = await fetchCodexToken({
      shellUrl: opts.shellUrl,
      bearer: opts.shellBearer,
      fetch: opts.fetch,
    });

    // Configure @openai/agents to route via chatgpt.com/backend-api with the
    // codex-specific headers. This is process-global; runs are sequential so
    // setting it per-call is safe.
    const client = new OpenAI({
      apiKey: token.accessToken,
      baseURL: "https://chatgpt.com/backend-api",
      defaultHeaders: {
        "OpenAI-Beta": "responses=experimental",
        "chatgpt-account-id": token.accountId,
        originator: "vulture",
        session_id: input.runId,
        conversation_id: input.runId,
      },
    });
    setDefaultOpenAIClient(client);
    setOpenAIAPI("responses");
    setTracingDisabled(true);

    // Delegate to existing OpenAILlm machinery; it uses the client we just
    // configured. apiKey here is unused on the wire (OpenAI client already has
    // it), but makeOpenAILlm requires the parameter for non-codex callers.
    const inner = makeOpenAILlm({
      apiKey: token.accessToken,
      toolNames: opts.toolNames,
      toolCallable: opts.toolCallable,
    });
    yield* inner(input);
  };
}
