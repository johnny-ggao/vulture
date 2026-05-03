import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";

/**
 * Declarative form of an LLM script — kept JSON-serializable so acceptance
 * scenarios can carry it as plain data. Internally compiled into LlmYield
 * sequences when the runtime calls the LLM.
 *
 * `tool.call` expands to the runtime's `tool.plan` + `await.tool` pair:
 * the script emits the plan, the runtime invokes its toolCallable, and the
 * script discards the tool result and continues with the next op. This
 * unblocks scripted scenarios that need to drive real tool execution
 * (memory, plan, MCP, approval-gated tools) without scripting branching
 * on the tool's return value — branching belongs in a richer DSL future
 * iteration.
 */
export type ScriptedLlmYield =
  | { kind: "text.delta"; text: string }
  | {
      kind: "usage";
      usage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
    }
  | { kind: "tool.call"; callId: string; tool: string; input?: unknown }
  | { kind: "final"; text: string };

export interface ScriptedLlmStep {
  yields: ScriptedLlmYield[];
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
  yields: [
    {
      kind: "final",
      text:
        "OPENAI_API_KEY not configured. Set the key via Settings or set the env var, then retry.",
    },
  ],
};

export function makeScriptedLlm(options: ScriptedLlmOptions = {}): ScriptedLlmController {
  const fallback = options.fallback ?? DEFAULT_FALLBACK;
  let active: ScriptedLlmStep | null = null;

  const llm: LlmCallable = async function* (): AsyncGenerator<LlmYield, void, unknown> {
    const step = active ?? fallback;
    for (const op of step.yields) {
      if (op.kind === "tool.call") {
        yield { kind: "tool.plan", callId: op.callId, tool: op.tool, input: op.input };
        // The runtime resumes this generator with the tool's return value
        // (or throws into it on failure). The current DSL discards the
        // result; future ops can read it via branching primitives.
        yield { kind: "await.tool", callId: op.callId };
        continue;
      }
      if (op.kind === "usage") {
        yield {
          kind: "usage",
          usage: {
            inputTokens: op.usage.inputTokens ?? 0,
            outputTokens: op.usage.outputTokens ?? 0,
            totalTokens:
              op.usage.totalTokens ??
              (op.usage.inputTokens ?? 0) + (op.usage.outputTokens ?? 0),
          },
        };
        continue;
      }
      yield op;
    }
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
