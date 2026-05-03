import type { LlmCallable } from "@vulture/agent-runtime";
import type { ModelProvider } from "@openai/agents";
import type { LspClientManager } from "./runtime/lspClientManager";

export interface GatewayConfig {
  port: number;
  token: string;
  shellCallbackUrl: string;
  shellPid: number;
  profileDir: string;
  defaultWorkspace?: string;
  privateWorkspaceHomeDir?: string;
  memorySuggestionsEnabled?: boolean;
  /**
   * Test/harness-only injection point. When set, buildServer wires this
   * LlmCallable straight into runOrchestrator instead of the default
   * makeLazyLlm chain (Codex → API key → stub fallback). This bypasses the
   * OpenAI Agents SDK Runner — useful for scripting LlmYield-level
   * behavior, but it also bypasses the SDK approval gate. For approval
   * end-to-end tests use scriptedModelProvider instead.
   * Production callers leave this undefined.
   */
  llmOverride?: LlmCallable;
  /**
   * When both llmOverride and scriptedModelProvider are set, this thunk is
   * consulted on each LLM call to decide which path runs. Returning `true`
   * routes to llmOverride (legacy LlmCallable), `false` routes to the SDK
   * Runner driven by scriptedModelProvider. The acceptance harness uses
   * this to switch per-scenario based on which scripted controller has an
   * active step. When unset, llmOverride takes priority over scripted
   * ModelProvider as long as it is provided.
   */
  llmOverrideHasScript?: () => boolean;
  /**
   * Test/harness-only ModelProvider override. When set, the gateway runs
   * the real OpenAI Agents SDK Runner against this provider — so the SDK
   * approval gate, tool dispatch, and run loop behave exactly like
   * production, just driven by a scripted "model" instead of a real one.
   * Acceptance scenarios use this to script approval allow/deny e2e.
   * Production callers leave this undefined.
   */
  scriptedModelProvider?: ModelProvider;
  /**
   * When true, buildServer registers the harness.test_approval tool. The
   * tool always requires approval and trivially echoes its input on
   * execute, giving acceptance scenarios a deterministic way to drive
   * the SDK approval gate without depending on workspace boundaries
   * (write/edit/shell.exec) or the desktop shell bridge (browser.*).
   * Production callers leave this off.
   */
  registerHarnessTestTools?: boolean;
  /**
   * Optional LSP client manager, constructed in main.ts so tests don't
   * accumulate sweepers or SIGTERM listeners. Consumed in the local-tool
   * dispatcher to handle lsp.* tool calls.
   */
  lspManager?: LspClientManager;
}

function required(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const v = env[key];
  if (!v) {
    throw new Error(`${key} env var is required`);
  }
  return v;
}

export function parseGatewayEnv(
  env: Record<string, string | undefined>,
): GatewayConfig {
  const portStr = required(env, "VULTURE_GATEWAY_PORT");
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(
      `VULTURE_GATEWAY_PORT must be a valid port: got ${portStr}`,
    );
  }

  const token = required(env, "VULTURE_GATEWAY_TOKEN");
  if (token.length !== 43) {
    throw new Error(
      `VULTURE_GATEWAY_TOKEN must be 43 chars (32 bytes b64url)`,
    );
  }

  const pidStr = required(env, "VULTURE_SHELL_PID");
  const shellPid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(shellPid) || shellPid < 1) {
    throw new Error(`VULTURE_SHELL_PID must be a positive integer`);
  }

  return {
    port,
    token,
    shellCallbackUrl: required(env, "VULTURE_SHELL_CALLBACK_URL"),
    shellPid,
    profileDir: required(env, "VULTURE_PROFILE_DIR"),
    defaultWorkspace: env.VULTURE_DEFAULT_WORKSPACE,
    memorySuggestionsEnabled: env.VULTURE_MEMORY_SUGGESTIONS === "1",
  };
}
