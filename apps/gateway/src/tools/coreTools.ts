import path from "node:path";
import { z } from "zod";
import { ToolRegistry } from "./registry";
import type {
  GatewayToolApprovalDecision,
  GatewayToolExecutionContext,
  GatewayToolSpec,
} from "./types";

const shellExecParameters = z.object({
  cwd: z.string(),
  argv: z.array(z.string()),
  // Codex backend enforces strict JSON schema: every property must appear in
  // `required`. Nullable lets the model pass null when it has no preference.
  timeoutMs: z.number().int().positive().nullable(),
});

const browserSnapshotParameters = z.object({});
const browserClickParameters = z.object({ selector: z.string() });

export function createCoreToolRegistry(): ToolRegistry {
  return new ToolRegistry([shellExecTool(), browserSnapshotTool(), browserClickTool()]);
}

function shellExecTool(): GatewayToolSpec {
  return {
    id: "shell.exec",
    sdkName: "shell_exec",
    label: "Shell Exec",
    description: "Execute a shell command in the workspace. Returns stdout/stderr/exitCode.",
    parameters: shellExecParameters,
    source: "core",
    category: "runtime",
    risk: "approval",
    needsApproval: (ctx, input) => shellExecApprovalDecision(input, ctx.workspacePath),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "shell.exec", input),
  };
}

function browserSnapshotTool(): GatewayToolSpec {
  return {
    id: "browser.snapshot",
    sdkName: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Capture a screenshot or DOM snapshot of the current browser tab.",
    parameters: browserSnapshotParameters,
    source: "core",
    category: "browser",
    risk: "approval",
    needsApproval: () => ({
      needsApproval: true,
      reason: "browser.snapshot requires browser approval",
    }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "browser.snapshot", input),
  };
}

function browserClickTool(): GatewayToolSpec {
  return {
    id: "browser.click",
    sdkName: "browser_click",
    label: "Browser Click",
    description: "Click an element by selector in the browser.",
    parameters: browserClickParameters,
    source: "core",
    category: "browser",
    risk: "approval",
    needsApproval: () => ({
      needsApproval: true,
      reason: "browser.click requires browser approval",
    }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "browser.click", input),
  };
}

async function executeViaGatewayTool(
  ctx: GatewayToolExecutionContext,
  tool: string,
  input: unknown,
): Promise<unknown> {
  return await ctx.toolCallable({
    callId: ctx.callId,
    tool,
    input,
    runId: ctx.runId,
    workspacePath: ctx.workspacePath,
    approvalToken: ctx.approvalToken,
  });
}

export function coreToolApprovalDecision(
  toolName: string,
  input: unknown,
  workspacePath: string | undefined,
): GatewayToolApprovalDecision {
  switch (toolName) {
    case "browser.snapshot":
    case "browser.click":
      return {
        needsApproval: true,
        reason: `${toolName} requires browser approval`,
      };
    case "shell.exec":
      return shellExecApprovalDecision(input, workspacePath);
    default:
      return { needsApproval: false };
  }
}

function shellExecApprovalDecision(
  input: unknown,
  workspacePath: string | undefined,
): GatewayToolApprovalDecision {
  const value = input as { cwd?: unknown; argv?: unknown };
  if (typeof value.cwd !== "string") {
    return { needsApproval: true, reason: "shell.exec missing cwd" };
  }
  if (!path.isAbsolute(value.cwd)) {
    return { needsApproval: true, reason: "shell.exec cwd must be absolute" };
  }
  if (!workspacePath) {
    return { needsApproval: true, reason: "shell.exec outside known workspace" };
  }
  const workspaceRoot = path.resolve(workspacePath);
  const cwd = path.resolve(value.cwd);
  if (!isInsidePath(cwd, workspaceRoot)) {
    return { needsApproval: true, reason: "shell.exec outside workspace" };
  }
  if (shellExecReferencesOutsideWorkspace(value.argv, cwd, workspaceRoot)) {
    return {
      needsApproval: true,
      reason: "shell.exec references path outside workspace",
    };
  }
  return { needsApproval: false };
}

function shellExecReferencesOutsideWorkspace(
  argv: unknown,
  cwd: string,
  workspaceRoot: string,
): boolean {
  if (!Array.isArray(argv)) return false;
  const args = argv.filter((arg): arg is string => typeof arg === "string");
  const directReference = args
    .slice(1)
    .some((arg) => shellArgReferencesOutsideWorkspace(arg, cwd, workspaceRoot));
  return directReference || shellCommandReferencesOutsideWorkspace(args, cwd, workspaceRoot);
}

function shellCommandReferencesOutsideWorkspace(
  args: string[],
  cwd: string,
  workspaceRoot: string,
): boolean {
  const shell = args[0] ? path.basename(args[0]) : "";
  if (shell !== "bash" && shell !== "sh" && shell !== "zsh") return false;
  const command = shellCommandArg(args);
  if (!command) return false;
  return command
    .split(/[\s"';&|<>()]+/)
    .filter(Boolean)
    .some((token) => shellArgReferencesOutsideWorkspace(token, cwd, workspaceRoot));
}

function shellCommandArg(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-c" || arg === "-lc") return args[i + 1];
    if (arg.startsWith("-") && arg.includes("c")) return args[i + 1];
  }
  return undefined;
}

function shellArgReferencesOutsideWorkspace(
  arg: string,
  cwd: string,
  workspaceRoot: string,
): boolean {
  if (!arg || arg.startsWith("-") || arg.includes("://")) return false;
  if (path.isAbsolute(arg)) {
    return !isInsidePath(path.resolve(arg), workspaceRoot);
  }
  if (looksLikeRelativePath(arg)) {
    return !isInsidePath(path.resolve(cwd, arg), workspaceRoot);
  }
  return false;
}

function looksLikeRelativePath(arg: string): boolean {
  return (
    arg === "." ||
    arg === ".." ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.includes("/")
  );
}

function isInsidePath(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
