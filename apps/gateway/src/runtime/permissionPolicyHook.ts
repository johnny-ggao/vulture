import type { PermissionPolicyStore } from "../domain/permissionPolicyStore";
import type { RunStore } from "../domain/runStore";
import type {
  RuntimeHookRegistration,
  ToolBeforeCallEvent,
  ToolBeforeCallResult,
} from "./runtimeHooks";

export interface PermissionPolicyHookDeps {
  policies: PermissionPolicyStore;
  runs: RunStore;
}

/**
 * Builds a tool.beforeCall hook that consults PermissionPolicyStore. A "deny"
 * decision blocks the tool call; "allow" / "ask" leave the call alone so the
 * SDK's needsApproval path or operator UI can take over.
 */
export function makePermissionPolicyHook(
  deps: PermissionPolicyHookDeps,
): RuntimeHookRegistration {
  return {
    name: "tool.beforeCall",
    priority: 100,
    failurePolicy: "fail-closed",
    handler: (event) => evaluate(deps, event),
  };
}

function evaluate(
  deps: PermissionPolicyHookDeps,
  event: ToolBeforeCallEvent,
): ToolBeforeCallResult | undefined {
  const run = deps.runs.get(event.runId);
  const decision = deps.policies.explain({
    agentId: run?.agentId ?? null,
    toolId: event.toolId,
    category: event.category ?? null,
    command: extractCommand(event.input),
  });
  if (decision.action !== "deny") return undefined;
  return {
    block: true,
    blockReason: formatBlockReason(decision.reason, decision.matchedRule?.id),
  };
}

function extractCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const argv = (input as { argv?: unknown }).argv;
  if (Array.isArray(argv) && argv.length > 0 && typeof argv[0] === "string") {
    return argv.join(" ");
  }
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

function formatBlockReason(reason: string, ruleId: string | undefined): string {
  if (!ruleId) return reason;
  return `${reason} (rule ${ruleId})`;
}
