import type { LlmCallable, ToolCallable } from "@vulture/agent-runtime";
import { makeOpenAILlm, makeStubLlmFallback } from "./openaiLlm";
import { AGENT_TOOL_NAMES } from "@vulture/protocol/src/v1/agent";

export interface ResolveLlmDeps {
  toolNames: readonly string[];
  toolCallable: ToolCallable;
  /** Test injection point. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Returns an LlmCallable that re-reads the API key from the environment on
 * every call. This allows the gateway to pick up a freshly configured key
 * (e.g. written via Tauri Keychain) without requiring a process restart.
 *
 * The inner LlmCallable (real or stub) is constructed per-call — it is a
 * cheap closure, so there is no meaningful performance overhead.
 */
export function makeLazyLlm(deps: ResolveLlmDeps): LlmCallable {
  return async function* (input) {
    const env = deps.env ?? process.env;
    const apiKey = env.OPENAI_API_KEY;
    const inner = apiKey
      ? makeOpenAILlm({
          apiKey,
          toolNames: deps.toolNames,
          toolCallable: deps.toolCallable,
        })
      : makeStubLlmFallback();
    yield* inner(input);
  };
}
