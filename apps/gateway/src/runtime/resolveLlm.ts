import type { LlmCallable, LlmYield, ToolCallable } from "@vulture/agent-runtime";
import {
  makeOpenAILlm,
  makeStubLlmFallback,
  type OpenAILlmOptions,
  type McpToolProvider,
  type SdkApprovalCallable,
} from "./openaiLlm";
import {
  fetchCodexToken,
  makeCodexLlm,
  type CodexShellError,
  type CodexShellResponse,
} from "./codexLlm";

export interface ResolveLlmDeps {
  toolNames: readonly string[];
  toolCallable: ToolCallable;
  env?: Record<string, string | undefined>;
  shellCallbackUrl: string;
  shellToken: string;
  approvalCallable?: SdkApprovalCallable;
  mcpToolProvider?: McpToolProvider;
  runFactory?: OpenAILlmOptions["runFactory"];
  runtimeHooks?: OpenAILlmOptions["runtimeHooks"];
  /** Test injection point. Defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * 3-way LLM resolution: Codex (if signed in) > API key (if set) > stub.
 *
 * The selected provider is passed into the Agents SDK Runner for each run.
 * This resolver does not mutate @openai/agents process-global client state.
 */
export function makeLazyLlm(deps: ResolveLlmDeps): LlmCallable {
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    let codexState: "available" | "not_signed_in" | "expired" = "not_signed_in";
    let codexToken: CodexShellResponse | undefined;
    try {
      codexToken = await fetchCodexToken({
        shellUrl: deps.shellCallbackUrl,
        bearer: deps.shellToken,
        fetch: deps.fetch,
      });
      codexState = "available";
    } catch (cause) {
      const err = cause as CodexShellError;
      switch (err.code) {
        case "auth.codex_expired":
          codexState = "expired";
          break;
        case "auth.codex_not_signed_in":
        case "internal":
        default:
          // Treat shell faults the same as "not signed in" — falls through to
          // API key (or stub) so a transient shell error doesn't block the run.
          codexState = "not_signed_in";
          break;
      }
    }

    if (codexState === "available") {
      const inner = makeCodexLlm({
        shellUrl: deps.shellCallbackUrl,
        shellBearer: deps.shellToken,
        toolNames: deps.toolNames,
        toolCallable: deps.toolCallable,
        fetch: deps.fetch,
        codexToken,
        approvalCallable: deps.approvalCallable,
        mcpToolProvider: deps.mcpToolProvider,
        runFactory: deps.runFactory,
        runtimeHooks: deps.runtimeHooks,
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
      const inner = makeOpenAILlm({
        apiKey,
        toolNames: deps.toolNames,
        toolCallable: deps.toolCallable,
        approvalCallable: deps.approvalCallable,
        mcpToolProvider: deps.mcpToolProvider,
        runFactory: deps.runFactory,
        runtimeHooks: deps.runtimeHooks,
      });
      yield* inner(input);
      return;
    }
    yield* makeStubLlmFallback()(input);
  };
}
