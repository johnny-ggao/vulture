import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "@openai/agents";

/**
 * Scripted ModelProvider — a fake @openai/agents Model that pulls its
 * "responses" from a per-scenario script instead of calling a real model.
 *
 * Why this exists: the existing ScriptedLlm controller injects at the
 * agent-runtime LlmCallable layer and bypasses the OpenAI Agents SDK
 * Runner. That makes it impossible to script flows that depend on the SDK
 * — most importantly, the approval gate (Tool.needsApproval +
 * approvalCallable + approvalQueue + tool.ask events). This provider sits
 * one layer up: it satisfies the SDK's Model contract, so the SDK Runner
 * runs its real loop on top of our scripted output, and the production
 * approval path is exercised end-to-end.
 *
 * The script is a list of turns. Each turn is one Runner→Model call
 * worth of output: assistant text plus zero-or-more function_call items.
 * The Runner receives turn N, calls any tools (going through the real
 * approval gate), then calls Model.getStreamedResponse again — at which
 * point we hand it turn N+1.
 *
 * Out of scope for this iteration:
 *   - Streaming text deltas mid-turn (we emit one delta per turn covering
 *     the whole turn's text). The Runner only cares about the final
 *     output array; deltas exist for UX, not protocol.
 *   - Reasoning / hosted-tool / handoff items.
 *   - Per-turn usage accounting.
 */
export interface ScriptedModelToolCall {
  callId: string;
  /** SDK tool name (e.g. "harness_test_approval"), not the gateway id. */
  name: string;
  /** Will be JSON.stringify'd for the SDK. */
  arguments: unknown;
}

export interface ScriptedModelTurn {
  /**
   * Optional assistant message text emitted on this turn.
   * - `string`: emitted as a single output_text_delta (and packed into the
   *   message item's content).
   * - `string[]`: emitted as multiple output_text_delta events in order;
   *   the final message content concatenates them. Use this when you want
   *   to test streaming UX.
   */
  text?: string | string[];
  /** Optional tool calls emitted on this turn. */
  toolCalls?: ScriptedModelToolCall[];
}

export interface ScriptedModelStep {
  turns: ScriptedModelTurn[];
}

export interface ScriptedModelController {
  readonly provider: ModelProvider;
  /** Replace the active script and reset the turn cursor. */
  setStep(step: ScriptedModelStep | null): void;
  current(): ScriptedModelStep | null;
  /** Number of turns the Runner has consumed since the last setStep. */
  turnsConsumed(): number;
  reset(): void;
}

const EMPTY_USAGE = {
  requests: 1,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

const DEFAULT_FALLBACK_TURN: ScriptedModelTurn = {
  text: "scripted model: no script set",
};

const SCRIPT_EXHAUSTED_TURN: ScriptedModelTurn = {
  text: "scripted model: script exhausted",
};

export function makeScriptedModelProvider(): ScriptedModelController {
  let active: ScriptedModelStep | null = null;
  let turnIdx = 0;

  const nextTurn = (): ScriptedModelTurn => {
    if (!active) return DEFAULT_FALLBACK_TURN;
    const turn = active.turns[turnIdx];
    turnIdx += 1;
    return turn ?? SCRIPT_EXHAUSTED_TURN;
  };

  const flattenText = (text: ScriptedModelTurn["text"]): string => {
    if (!text) return "";
    return Array.isArray(text) ? text.join("") : text;
  };

  const textDeltas = (text: ScriptedModelTurn["text"]): string[] => {
    if (!text) return [];
    return Array.isArray(text) ? text : [text];
  };

  const buildOutput = (turn: ScriptedModelTurn) => {
    const output: Array<Record<string, unknown>> = [];
    const flat = flattenText(turn.text);
    if (flat) {
      output.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: flat }],
      });
    }
    for (const call of turn.toolCalls ?? []) {
      output.push({
        type: "function_call",
        callId: call.callId,
        name: call.name,
        status: "completed",
        arguments:
          typeof call.arguments === "string"
            ? call.arguments
            : JSON.stringify(call.arguments ?? {}),
      });
    }
    return output;
  };

  const buildResponseId = (): string => `scripted-${turnIdx}`;

  const model: Model = {
    async getResponse(_request: ModelRequest): Promise<ModelResponse> {
      const turn = nextTurn();
      return {
        usage: EMPTY_USAGE,
        output: buildOutput(turn),
        responseId: buildResponseId(),
      } as unknown as ModelResponse;
    },
    async *getStreamedResponse(_request: ModelRequest) {
      const turn = nextTurn();
      const responseId = buildResponseId();
      yield { type: "response_started" as const } as unknown as never;
      for (const delta of textDeltas(turn.text)) {
        yield {
          type: "output_text_delta" as const,
          delta,
        } as unknown as never;
      }
      yield {
        type: "response_done" as const,
        response: {
          id: responseId,
          usage: EMPTY_USAGE,
          output: buildOutput(turn),
        },
      } as unknown as never;
    },
  };

  const provider: ModelProvider = {
    getModel: () => model,
  };

  return {
    provider,
    setStep(step) {
      active = step;
      turnIdx = 0;
    },
    current() {
      return active;
    },
    turnsConsumed() {
      return turnIdx;
    },
    reset() {
      active = null;
      turnIdx = 0;
    },
  };
}
