import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";

/**
 * Declarative form of an LLM script — kept JSON-serializable so acceptance
 * scenarios can carry it as plain data. Internally compiled into LlmYield
 * sequences when the runtime calls the LLM.
 *
 * Future expansion: tool.plan / await.tool / failure entries to drive
 * approval flow scenarios end-to-end. The current shape covers text-only
 * runs.
 */
export interface ScriptedLlmStep {
  /** Streamed deltas in order. Concatenated for the assistant message. */
  deltas?: string[];
  /**
   * Final assistant text. Required — the runtime expects a final text
   * yield to terminate the run successfully.
   */
  final: string;
  /**
   * Optional usage block. Defaults to zero-token usage when omitted so the
   * runtime still records a usage event for the run.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface ScriptedLlmController {
  /** The LlmCallable to wire into GatewayConfig.llmOverride. */
  readonly llm: LlmCallable;
  /**
   * Set the script consumed by the next LLM call. Subsequent calls reuse
   * the same script until setStep is called again.
   */
  setStep(step: ScriptedLlmStep | null): void;
  /** Return whatever script is currently active (or null). */
  current(): ScriptedLlmStep | null;
  /** Drop the active script so the LLM falls back to the default. */
  reset(): void;
}

export interface ScriptedLlmOptions {
  /**
   * Yields used when no script is set. Defaults to a single placeholder
   * final-text yield that mirrors the makeStubLlmFallback message — keeps
   * existing acceptance scenarios passing without changes.
   */
  fallback?: ScriptedLlmStep;
}

const DEFAULT_FALLBACK: ScriptedLlmStep = {
  final:
    "OPENAI_API_KEY not configured. Set the key via Settings or set the env var, then retry.",
};

export function makeScriptedLlm(options: ScriptedLlmOptions = {}): ScriptedLlmController {
  const fallback = options.fallback ?? DEFAULT_FALLBACK;
  let active: ScriptedLlmStep | null = null;

  const llm: LlmCallable = async function* (): AsyncGenerator<LlmYield, void, unknown> {
    const step = active ?? fallback;
    for (const delta of step.deltas ?? []) {
      yield { kind: "text.delta", text: delta };
    }
    if (step.usage) {
      yield {
        kind: "usage",
        usage: {
          inputTokens: step.usage.inputTokens ?? 0,
          outputTokens: step.usage.outputTokens ?? 0,
          totalTokens:
            step.usage.totalTokens ??
            (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0),
        },
      };
    }
    yield { kind: "final", text: step.final };
  };

  return {
    llm,
    setStep(step) {
      active = step;
    },
    current() {
      return active;
    },
    reset() {
      active = null;
    },
  };
}
