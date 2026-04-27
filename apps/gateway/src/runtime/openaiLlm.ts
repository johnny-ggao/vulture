import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";
import { selectModel } from "@vulture/llm";

/**
 * Internal event shape representing one normalized step from the @openai/agents
 * Run stream. The default `runFactory` translates SDK events into this shape;
 * tests inject a deterministic stream directly.
 */
export type SdkRunEvent =
  | { kind: "text.delta"; text: string }
  | { kind: "tool.plan"; callId: string; tool: string; input: unknown }
  | { kind: "await.tool"; callId: string }
  | { kind: "final"; text: string };

export interface OpenAILlmOptions {
  apiKey: string;
  toolNames: readonly string[];
  /**
   * Factory that returns an async iterable of SDK events for one run. Default
   * (defined in Task 12) uses the real @openai/agents Run; tests inject a
   * deterministic stream so this module's translation logic is unit-testable.
   */
  runFactory?: (input: {
    systemPrompt: string;
    userInput: string;
    model: string;
    apiKey: string;
    toolNames: readonly string[];
  }) => AsyncIterable<SdkRunEvent>;
}

export function makeOpenAILlm(opts: OpenAILlmOptions): LlmCallable {
  const factory = opts.runFactory ?? defaultRunFactory;
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    const stream = factory({
      systemPrompt: input.systemPrompt,
      userInput: input.userInput,
      model: selectModel(input.model),
      apiKey: opts.apiKey,
      toolNames: opts.toolNames,
    });
    for await (const event of stream) {
      yield event as LlmYield;
    }
  };
}

export function makeStubLlmFallback(): LlmCallable {
  return async function* (): AsyncGenerator<LlmYield, void, unknown> {
    yield {
      kind: "final",
      text:
        "OPENAI_API_KEY not configured. Set the key via Settings or set the env var, then retry.",
    };
  };
}

async function* defaultRunFactory(input: {
  systemPrompt: string;
  userInput: string;
  model: string;
  apiKey: string;
  toolNames: readonly string[];
}): AsyncIterable<SdkRunEvent> {
  // The @openai/agents SDK's Run streaming API. The exact import + event shape
  // must be verified at implementation time. This stub raises so the implementer
  // is forced to wire the real translation in Task 12.
  throw new Error(
    `defaultRunFactory not implemented. Wire @openai/agents Run here. (model=${input.model}, tools=${input.toolNames.join(",")})`,
  );
}
