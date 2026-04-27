import OpenAI from "openai";
import { setDefaultOpenAIClient, setOpenAIAPI } from "@openai/agents";
import type { LlmCallable, LlmYield, ToolCallable } from "@vulture/agent-runtime";
import { makeOpenAILlm, makeStubLlmFallback } from "./openaiLlm";
import { fetchCodexToken, makeCodexLlm, type CodexShellError } from "./codexLlm";

export interface ResolveLlmDeps {
  toolNames: readonly string[];
  toolCallable: ToolCallable;
  env?: Record<string, string | undefined>;
  shellCallbackUrl: string;
  shellToken: string;
  /** Test injection point. Defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * 3-way LLM resolution: Codex (if signed in) > API key (if set) > stub.
 *
 * SDK state contract:
 * `codexLlm` mutates @openai/agents process-global state when it runs.
 * Whenever this resolver chooses the API key path, it FIRST resets the
 * SDK default client to a vanilla `api.openai.com` OpenAI instance so a
 * prior codex run doesn't leak into subsequent API-key requests.
 */
export function makeLazyLlm(deps: ResolveLlmDeps): LlmCallable {
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    let codexState: "available" | "not_signed_in" | "expired" = "not_signed_in";
    try {
      await fetchCodexToken({
        shellUrl: deps.shellCallbackUrl,
        bearer: deps.shellToken,
        fetch: deps.fetch,
      });
      codexState = "available";
    } catch (cause) {
      const err = cause as CodexShellError;
      if (err.code === "auth.codex_expired") codexState = "expired";
      else codexState = "not_signed_in";
    }

    if (codexState === "available") {
      const inner = makeCodexLlm({
        shellUrl: deps.shellCallbackUrl,
        shellBearer: deps.shellToken,
        toolNames: deps.toolNames,
        toolCallable: deps.toolCallable,
        fetch: deps.fetch,
      });
      yield* inner(input);
      return;
    }

    if (codexState === "expired") {
      // Explicit fallback (do NOT silently downgrade to API key — see spec
      // invariant 4: avoid surprise billing).
      yield {
        kind: "final",
        text: "Codex 已过期，请重新登录（侧栏 设置 → Sign in with ChatGPT）",
      };
      return;
    }

    // codexState === "not_signed_in" → API key path
    const env = deps.env ?? process.env;
    const apiKey = env.OPENAI_API_KEY;
    if (apiKey) {
      // Reset SDK default client so a prior codex run doesn't leak baseURL
      // (chatgpt.com) into this api.openai.com call.
      setDefaultOpenAIClient(new OpenAI({ apiKey }));
      setOpenAIAPI("responses");
      const inner = makeOpenAILlm({
        apiKey,
        toolNames: deps.toolNames,
        toolCallable: deps.toolCallable,
      });
      yield* inner(input);
      return;
    }
    yield* makeStubLlmFallback()(input);
  };
}
