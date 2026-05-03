import type { LlmCallable, LlmYield, ToolCallable } from "@vulture/agent-runtime";
import {
  makeOpenAILlm,
  makeStubLlmFallback,
  type OpenAILlmOptions,
  type McpToolProvider,
  type SdkApprovalCallable,
} from "./openaiLlm";
import { resolveRuntimeModelProvider } from "./modelProviderResolver";

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
    const resolved = await resolveRuntimeModelProvider({
      modelRef: input.model,
      env: deps.env,
      shellCallbackUrl: deps.shellCallbackUrl,
      shellToken: deps.shellToken,
      fetch: deps.fetch,
      runId: input.runId,
    });

    if (resolved.kind === "provider") {
      const inner = makeOpenAILlm({
        apiKey: resolved.apiKey,
        modelProvider: resolved.modelProvider,
        toolNames: deps.toolNames,
        toolCallable: deps.toolCallable,
        approvalCallable: deps.approvalCallable,
        mcpToolProvider: deps.mcpToolProvider,
        runFactory: deps.runFactory,
        runtimeHooks: deps.runtimeHooks,
      });
      yield* inner({ ...input, model: resolved.model });
      return;
    }

    if (
      resolved.provider === "openai" &&
      resolved.profileId === "openai-api-key" &&
      resolved.message.includes("OPENAI_API_KEY")
    ) {
      yield* makeStubLlmFallback()(input);
      return;
    }

    yield {
      kind: "final",
      text: resolved.message,
    };
    return;
  };
}
