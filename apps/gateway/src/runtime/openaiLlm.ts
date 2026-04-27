import { Agent, Runner, tool } from "@openai/agents";
import type { Tool } from "@openai/agents";
import { z } from "zod";
import type { LlmCallable, LlmYield, ToolCallable } from "@vulture/agent-runtime";

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

interface RunFactoryInput {
  systemPrompt: string;
  userInput: string;
  model: string;
  apiKey: string;
  toolNames: readonly string[];
  toolCallable: ToolCallable;
  runId: string;
  workspacePath: string;
}

export interface OpenAILlmOptions {
  apiKey: string;
  toolNames: readonly string[];
  toolCallable: ToolCallable;
  /**
   * Factory that returns an async iterable of SDK events for one run. Default
   * uses the real @openai/agents Run; tests inject a deterministic stream so
   * this module's translation logic is unit-testable.
   */
  runFactory?: (input: RunFactoryInput) => AsyncIterable<SdkRunEvent>;
}

export function makeOpenAILlm(opts: OpenAILlmOptions): LlmCallable {
  const factory = opts.runFactory ?? defaultRunFactory;
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    const stream = factory({
      systemPrompt: input.systemPrompt,
      userInput: input.userInput,
      model: input.model,
      apiKey: opts.apiKey,
      toolNames: opts.toolNames,
      toolCallable: opts.toolCallable,
      runId: input.runId,
      workspacePath: input.workspacePath,
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

interface SdkRunContext {
  runId: string;
  workspacePath: string;
  toolCallable: ToolCallable;
}

async function* defaultRunFactory(
  input: RunFactoryInput,
): AsyncIterable<SdkRunEvent> {
  // The SDK reads OPENAI_API_KEY from the environment. Set it from the
  // caller-provided key when missing or differing — gateway is single-tenant.
  if (input.apiKey && process.env.OPENAI_API_KEY !== input.apiKey) {
    process.env.OPENAI_API_KEY = input.apiKey;
  }

  const tools: Tool[] = input.toolNames.map((name) => makeSdkTool(name));
  const agent = new Agent<SdkRunContext>({
    name: "local-work",
    instructions: input.systemPrompt,
    model: input.model,
    tools,
  });

  const runner = new Runner();
  const stream = await runner.run(agent, input.userInput, {
    stream: true,
    context: {
      runId: input.runId,
      workspacePath: input.workspacePath,
      toolCallable: input.toolCallable,
    },
  });

  for await (const event of stream) {
    if (event.type === "raw_model_stream_event") {
      const data = event.data as { type?: string; delta?: string };
      if (data?.type === "output_text_delta" && typeof data.delta === "string") {
        yield { kind: "text.delta", text: data.delta };
      }
    }
    // run_item_stream_event covers tool lifecycle. We DO NOT yield tool.plan /
    // await.tool here because the SDK invokes Tool.execute internally — the
    // runner's `await args.tools(...)` path is bypassed for openaiLlm. Tool
    // visibility instead surfaces via:
    //   - tool.ask events emitted from inside makeShellCallbackTools when an
    //     approval is required (those land in run_events normally),
    //   - the model's natural-language summary of the tool result in the
    //     subsequent text deltas.
    // Phase 4 can add proper SDK→LlmYield tool event mapping if desired.
  }

  await stream.completed;
  const final = stream.finalOutput;
  yield { kind: "final", text: typeof final === "string" ? final : "" };
}

function makeSdkTool(toolName: string): Tool {
  // Build a tool whose execute() routes through the user-provided ToolCallable
  // captured in RunContext.context.toolCallable.
  if (toolName === "shell.exec") {
    return tool({
      name: "shell.exec",
      description:
        "Execute a shell command in the workspace. Returns stdout/stderr/exitCode.",
      parameters: z.object({
        cwd: z.string(),
        argv: z.array(z.string()),
        timeoutMs: z.number().int().positive().default(120_000).optional(),
      }),
      execute: async (input, context, details) => {
        const ctx = context?.context as SdkRunContext | undefined;
        if (!ctx) throw new Error("makeOpenAILlm: missing SdkRunContext");
        const callId = details?.toolCall?.callId ?? `c-${crypto.randomUUID()}`;
        return await ctx.toolCallable({
          callId,
          tool: "shell.exec",
          input,
          runId: ctx.runId,
          workspacePath: ctx.workspacePath,
        });
      },
    });
  }
  if (toolName === "browser.snapshot") {
    return tool({
      name: "browser.snapshot",
      description:
        "Capture a screenshot or DOM snapshot of the current browser tab.",
      parameters: z.object({}),
      execute: async (input, context, details) => {
        const ctx = context?.context as SdkRunContext | undefined;
        if (!ctx) throw new Error("makeOpenAILlm: missing SdkRunContext");
        const callId = details?.toolCall?.callId ?? `c-${crypto.randomUUID()}`;
        return await ctx.toolCallable({
          callId,
          tool: "browser.snapshot",
          input,
          runId: ctx.runId,
          workspacePath: ctx.workspacePath,
        });
      },
    });
  }
  if (toolName === "browser.click") {
    return tool({
      name: "browser.click",
      description: "Click an element by selector in the browser.",
      parameters: z.object({ selector: z.string() }),
      execute: async (input, context, details) => {
        const ctx = context?.context as SdkRunContext | undefined;
        if (!ctx) throw new Error("makeOpenAILlm: missing SdkRunContext");
        const callId = details?.toolCall?.callId ?? `c-${crypto.randomUUID()}`;
        return await ctx.toolCallable({
          callId,
          tool: "browser.click",
          input,
          runId: ctx.runId,
          workspacePath: ctx.workspacePath,
        });
      },
    });
  }
  throw new Error(`makeOpenAILlm: unknown tool ${toolName}`);
}
