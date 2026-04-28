import OpenAI from "openai";
import { Agent, OpenAIProvider, RunContext, Runner, RunState } from "@openai/agents";
import type {
  ModelProvider,
  AgentInputItem,
  RunStreamEvent,
  RunToolApprovalItem,
  StreamedRunResult,
} from "@openai/agents";
import type {
  LlmCallable,
  LlmAttachment,
  LlmCheckpoint,
  LlmRecoveryInput,
  LlmYield,
  ToolCallable,
} from "@vulture/agent-runtime";
import type { TokenUsage } from "@vulture/protocol/src/v1/run";
import { createCoreToolRegistry } from "../tools/coreTools";
import { resolveEffectiveTools } from "../tools/registry";
import {
  sdkApprovalDecision,
  toSdkTool,
  type GatewayToolRunContext,
} from "../tools/sdkAdapter";
export { sdkApprovalDecision } from "../tools/sdkAdapter";

/**
 * Internal event shape representing one normalized step from the @openai/agents
 * Run stream. The default `runFactory` translates SDK events into this shape;
 * tests inject a deterministic stream directly.
 */
export type SdkRunEvent =
  | { kind: "text.delta"; text: string }
  | { kind: "tool.plan"; callId: string; tool: string; input: unknown }
  | { kind: "await.tool"; callId: string }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "final"; text: string };

export type SdkApprovalCallable = (request: {
  callId: string;
  tool: string;
  input: unknown;
  runId: string;
  workspacePath: string;
  reason: string;
  approvalToken: string;
}) => Promise<"allow" | "deny">;

export interface RunFactoryInput {
  systemPrompt: string;
  userInput: string;
  attachments?: LlmAttachment[];
  model: string;
  apiKey: string;
  toolNames: readonly string[];
  toolCallable: ToolCallable;
  runId: string;
  workspacePath: string;
  modelProvider: ModelProvider;
  tracingDisabled: boolean;
  approvalCallable?: SdkApprovalCallable;
  recovery?: LlmRecoveryInput;
  onCheckpoint?: (checkpoint: LlmCheckpoint) => void;
}

export interface OpenAILlmOptions {
  apiKey: string;
  toolNames: readonly string[];
  toolCallable: ToolCallable;
  modelProvider?: ModelProvider;
  tracingDisabled?: boolean;
  approvalCallable?: SdkApprovalCallable;
  /**
   * Factory that returns an async iterable of SDK events for one run. Default
   * uses the real @openai/agents Run; tests inject a deterministic stream so
   * this module's translation logic is unit-testable.
   */
  runFactory?: (input: RunFactoryInput) => AsyncIterable<SdkRunEvent>;
}

export function makeOpenAILlm(opts: OpenAILlmOptions): LlmCallable {
  const factory = opts.runFactory ?? defaultRunFactory;
  const modelProvider = opts.modelProvider ?? makeResponsesModelProvider({ apiKey: opts.apiKey });
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    const stream = factory({
      systemPrompt: input.systemPrompt,
      userInput: input.userInput,
      attachments: input.attachments,
      model: input.model,
      apiKey: opts.apiKey,
      toolNames: opts.toolNames,
      toolCallable: opts.toolCallable,
      runId: input.runId,
      workspacePath: input.workspacePath,
      modelProvider,
      tracingDisabled: opts.tracingDisabled ?? true,
      approvalCallable: opts.approvalCallable,
      recovery: input.recovery,
      onCheckpoint: input.onCheckpoint,
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

export type SdkRunContext = GatewayToolRunContext;

async function* defaultRunFactory(
  input: RunFactoryInput,
): AsyncIterable<SdkRunEvent> {
  const registry = createCoreToolRegistry();
  const tools = resolveEffectiveTools(registry, { allow: input.toolNames }).map(toSdkTool);
  const agent = new Agent<SdkRunContext>({
    name: "local-work",
    instructions: input.systemPrompt,
    model: input.model,
    tools,
    // chatgpt.com/backend-api/codex rejects `store: true` with 400. Setting
    // store=false on the API-key path is also fine (we don't use OpenAI's
    // server-side conversation retrieval; gateway persists everything).
    modelSettings: { store: false },
  });

  const runner = new Runner({
    modelProvider: input.modelProvider,
    tracingDisabled: input.tracingDisabled,
  });
  const context: SdkRunContext = {
    runId: input.runId,
    workspacePath: input.workspacePath,
    toolCallable: input.toolCallable,
    sdkApprovedToolCalls: new Map(),
    onCheckpoint: input.onCheckpoint,
  };
  const runContext = new RunContext(context);
  let runInput = await resolveSdkRunInput(
    agent,
    buildSdkUserInput(input.userInput, input.attachments),
    input.recovery,
    runContext,
  );
  const textDeltaDeduper = new SdkTextDeltaDeduper();

  while (true) {
    const stream = (await runner.run(agent, runInput, {
      stream: true,
      context: runContext,
    })) as StreamedRunResult<SdkRunContext, Agent<SdkRunContext, any>>;

    for await (const event of stream) {
      const delta = extractTextDeltaFromRunStreamEventDetails(event);
      if (delta && textDeltaDeduper.shouldEmit(delta)) {
        yield { kind: "text.delta", text: delta.text };
      }
      // run_item_stream_event covers tool lifecycle. We DO NOT yield tool.plan /
      // await.tool here because the SDK invokes Tool.execute internally — the
      // runner's `await args.tools(...)` path is bypassed for openaiLlm. Tool
      // visibility instead surfaces via run_events emitted from the tool
      // callback and SDK approval bridge.
    }

    await stream.completed;
    input.onCheckpoint?.({
      sdkState: stream.state.toString(),
      activeTool: null,
    });
    if (stream.interruptions.length === 0) {
      const usage = tokenUsageFromSdkUsage(stream.state.usage);
      if (usage) {
        yield { kind: "usage", usage };
      }
      const final = stream.finalOutput;
      yield { kind: "final", text: typeof final === "string" ? final : "" };
      return;
    }

    if (!input.approvalCallable) {
      throw new Error("makeOpenAILlm: SDK approval requested but no approvalCallable is configured");
    }
    for (const interruption of stream.interruptions) {
      const request = approvalRequestFromInterruption(interruption, input, context);
      const decision = await input.approvalCallable(request);
      if (decision === "allow") {
        context.sdkApprovedToolCalls.set(request.callId, request.approvalToken);
        stream.state.approve(interruption);
      } else {
        stream.state.reject(interruption, { message: `user denied ${request.tool}` });
      }
    }
    runInput = stream.state;
  }
}

export function tokenUsageFromSdkUsage(usage: unknown): TokenUsage | null {
  const value = usage as
    | {
        inputTokens?: unknown;
        outputTokens?: unknown;
        totalTokens?: unknown;
      }
    | undefined;
  if (
    typeof value?.inputTokens !== "number" ||
    typeof value.outputTokens !== "number" ||
    typeof value.totalTokens !== "number"
  ) {
    return null;
  }
  if (value.inputTokens === 0 && value.outputTokens === 0 && value.totalTokens === 0) {
    return null;
  }
  return {
    inputTokens: Math.max(0, Math.trunc(value.inputTokens)),
    outputTokens: Math.max(0, Math.trunc(value.outputTokens)),
    totalTokens: Math.max(0, Math.trunc(value.totalTokens)),
  };
}

export async function resolveSdkRunInput(
  agent: Agent<any, any>,
  userInput: string | AgentInputItem[],
  recovery: LlmRecoveryInput | undefined,
  runContext: RunContext<any>,
  fromStringWithContext: typeof RunState.fromStringWithContext = RunState.fromStringWithContext,
): Promise<string | AgentInputItem[] | RunState<any, Agent<any, any>>> {
  if (!recovery?.sdkState) return userInput;
  try {
    return await fromStringWithContext(agent, recovery.sdkState, runContext);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`internal.recovery_state_invalid: ${message}`);
  }
}

export function buildSdkUserInput(userInput: string, attachments: LlmAttachment[] = []): string | AgentInputItem[] {
  if (attachments.length === 0) return userInput;
  return [{
    type: "message" as const,
    role: "user" as const,
    content: [
      { type: "input_text" as const, text: userInput },
      ...attachments.map((attachment) => {
        const dataUrl = `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
        if (attachment.kind === "image") {
          return {
            type: "input_image" as const,
            image: dataUrl,
            detail: "auto",
          };
        }
        if (isTextAttachment(attachment)) {
          return {
            type: "input_text" as const,
            text: [
              `Attached file: ${attachment.displayName}`,
              `MIME type: ${attachment.mimeType}`,
              "Content:",
              decodeAttachmentText(attachment.dataBase64),
            ].join("\n"),
          };
        }
        return {
          type: "input_file" as const,
          file: dataUrl,
          filename: attachment.displayName,
        };
      }),
    ],
  }];
}

function isTextAttachment(attachment: LlmAttachment): boolean {
  return (
    attachment.mimeType.startsWith("text/") ||
    attachment.mimeType === "application/json" ||
    attachment.mimeType.endsWith("+json")
  );
}

function decodeAttachmentText(dataBase64: string): string {
  return Buffer.from(dataBase64, "base64").toString("utf8");
}

export async function sdkStateHasInterruptions(
  opts: {
    sdkState: string;
    agent: Agent<SdkRunContext, any>;
    context: SdkRunContext;
  },
  fromStringWithContext: typeof RunState.fromStringWithContext = RunState.fromStringWithContext,
): Promise<boolean> {
  const runContext = new RunContext(opts.context);
  const state = await fromStringWithContext(opts.agent, opts.sdkState, runContext);
  return state.getInterruptions().length > 0;
}

export function makeResponsesModelProvider(opts:
  | { apiKey: string; openAIClient?: never }
  | { apiKey?: never; openAIClient: OpenAI },
): ModelProvider {
  const openAIClient =
    opts.openAIClient ??
    new OpenAI({
      apiKey: opts.apiKey,
      // The gateway runs in Bun inside the desktop app, which the OpenAI JS
      // client treats as browser-like. This process is local server-side code;
      // the key is not exposed to the renderer.
      dangerouslyAllowBrowser: true,
    });
  return new OpenAIProvider({
    openAIClient,
    useResponses: true,
    cacheResponsesWebSocketModels: false,
  });
}

type TextDeltaSource = "normalized" | "raw-response" | "legacy";

export interface ExtractedTextDelta {
  text: string;
  source: TextDeltaSource;
  dedupeKey?: string;
}

export class SdkTextDeltaDeduper {
  #lastNormalizedDedupeKey: string | null = null;

  shouldEmit(delta: ExtractedTextDelta): boolean {
    if (delta.source === "raw-response" && delta.dedupeKey === this.#lastNormalizedDedupeKey) {
      return false;
    }
    if (delta.source === "normalized") {
      this.#lastNormalizedDedupeKey = delta.dedupeKey ?? null;
    }
    return true;
  }
}

export function extractTextDeltaFromRunStreamEvent(event: unknown): string | undefined {
  return extractTextDeltaFromRunStreamEventDetails(event)?.text;
}

export function extractTextDeltaFromRunStreamEventDetails(event: unknown): ExtractedTextDelta | undefined {
  const streamEvent = event as Partial<RunStreamEvent> | undefined;
  if (streamEvent?.type !== "raw_model_stream_event") return undefined;
  const data = streamEvent.data as
    | {
        type?: string;
        delta?: string;
        event?: { type?: string; delta?: string };
        choices?: unknown;
        providerData?: unknown;
      }
    | undefined;
  if (data?.type === "output_text_delta" && typeof data.delta === "string") {
    return {
      text: data.delta,
      source: "normalized",
      dedupeKey: responseTextDeltaDedupeKey(data.providerData, data.delta),
    };
  }
  const raw = data?.event ?? data;
  if (
    raw?.type === "response.output_text.delta" &&
    typeof raw.delta === "string"
  ) {
    return {
      text: raw.delta,
      source: "raw-response",
      dedupeKey: responseTextDeltaDedupeKey(raw, raw.delta),
    };
  }
  const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  const content = (choice as { delta?: { content?: unknown } } | undefined)?.delta?.content;
  return typeof content === "string"
    ? { text: content, source: "legacy" }
    : undefined;
}

function responseTextDeltaDedupeKey(event: unknown, delta: string): string | undefined {
  const value = event as
    | {
        type?: unknown;
        item_id?: unknown;
        itemId?: unknown;
        output_index?: unknown;
        outputIndex?: unknown;
        content_index?: unknown;
        contentIndex?: unknown;
        sequence_number?: unknown;
        sequenceNumber?: unknown;
      }
    | undefined;
  if (value?.type !== "response.output_text.delta") return undefined;
  return [
    value.type,
    scalarKey(value.item_id ?? value.itemId),
    scalarKey(value.output_index ?? value.outputIndex),
    scalarKey(value.content_index ?? value.contentIndex),
    scalarKey(value.sequence_number ?? value.sequenceNumber),
    delta,
  ].join("|");
}

function scalarKey(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function approvalRequestFromInterruption(
  interruption: RunToolApprovalItem,
  input: RunFactoryInput,
  context: SdkRunContext,
): Parameters<SdkApprovalCallable>[0] {
  const sdkToolName = interruption.name ?? "(unknown)";
  const tool = internalToolNameFromSdkName(sdkToolName);
  const parsedInput = parseToolArguments(interruption.arguments);
  const decision = sdkApprovalDecision(tool, parsedInput, context.workspacePath);
  const callId =
    "callId" in interruption.rawItem && typeof interruption.rawItem.callId === "string"
      ? interruption.rawItem.callId
      : `c-${crypto.randomUUID()}`;
  return {
    callId,
    tool,
    input: parsedInput,
    runId: input.runId,
    workspacePath: input.workspacePath,
    reason: decision.reason ?? `${tool} requires approval`,
    approvalToken: `sdk-approved-${callId}`,
  };
}

function parseToolArguments(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return {};
  }
}

function internalToolNameFromSdkName(toolName: string): string {
  switch (toolName) {
    case "shell_exec":
      return "shell.exec";
    case "browser_snapshot":
      return "browser.snapshot";
    case "browser_click":
      return "browser.click";
    default:
      return toolName;
  }
}

export function makeSdkTool(toolName: string) {
  const spec = createCoreToolRegistry().get(toolName);
  if (!spec) {
    throw new Error(`makeOpenAILlm: unknown tool ${toolName}`);
  }
  return toSdkTool(spec);
}
