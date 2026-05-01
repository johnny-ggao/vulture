import path from "node:path";
import { z } from "zod";
import { ToolRegistry } from "./registry";
import type { ConversationPermissionMode } from "@vulture/protocol/src/v1/conversation";
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

const readParameters = z.object({
  path: z.string(),
  maxBytes: z.number().int().positive().nullable(),
});
const writeParameters = z.object({
  path: z.string(),
  content: z.string(),
});
const editParameters = z.object({
  path: z.string(),
  oldText: z.string(),
  newText: z.string(),
  replaceAll: z.boolean().nullable(),
});
const applyPatchParameters = z.object({
  cwd: z.string(),
  patch: z.string(),
});
const processParameters = z.object({
  action: z.enum(["start", "list", "read", "stop"]),
  processId: z.string().nullable(),
  cwd: z.string().nullable(),
  argv: z.array(z.string()).nullable(),
});
const webSearchParameters = z.object({
  query: z.string(),
  limit: z.number().int().positive().nullable(),
});
const webFetchParameters = z.object({
  url: z.string(),
  maxBytes: z.number().int().positive().nullable(),
});
const webExtractParameters = z.object({
  url: z.string(),
  maxBytes: z.number().int().positive().nullable(),
  maxLinks: z.number().int().min(0).nullable(),
});
const sessionsListParameters = z.object({
  parentConversationId: z.string().nullable(),
  parentRunId: z.string().nullable(),
  agentId: z.string().nullable(),
  limit: z.number().int().positive().nullable(),
});
const sessionsHistoryParameters = z.object({
  sessionId: z.string().nullable(),
  conversationId: z.string().nullable(),
  limit: z.number().int().positive().nullable(),
});
const sessionsSendParameters = z.object({
  sessionId: z.string().nullable(),
  conversationId: z.string().nullable(),
  message: z.string(),
});
const sessionsSpawnParameters = z.object({
  agentId: z.string().nullable(),
  title: z.string().nullable(),
  label: z.string().nullable(),
  message: z.string().nullable(),
});
const sessionsYieldParameters = z.object({
  parentConversationId: z.string().nullable(),
  parentRunId: z.string().nullable(),
  limit: z.number().int().positive().nullable(),
  message: z.string().nullable(),
});
const updatePlanParameters = z.object({
  items: z.array(
    z.object({
      step: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
  ),
});
const memorySearchParameters = z.object({
  query: z.string(),
  limit: z.number().int().positive().nullable(),
});
const memoryGetParameters = z.object({
  id: z.string().nullable(),
  path: z.string().nullable(),
});
const memoryAppendParameters = z.object({
  path: z.string(),
  content: z.string(),
});
const browserSnapshotParameters = z.object({});
const browserClickParameters = z.object({ selector: z.string() });
const browserInputParameters = z.object({
  selector: z.string(),
  text: z.string(),
  submit: z.boolean().nullable(),
});
const browserScrollParameters = z.object({
  selector: z.string().nullable(),
  deltaY: z.number().nullable(),
});
const browserExtractParameters = z.object({
  maxTextChars: z.number().int().positive().nullable(),
  maxLinks: z.number().int().min(0).nullable(),
});

export function createCoreToolRegistry(): ToolRegistry {
  return new ToolRegistry([
    readTool(),
    writeTool(),
    editTool(),
    applyPatchTool(),
    shellExecTool(),
    processTool(),
    webSearchTool(),
    webFetchTool(),
    webExtractTool(),
    sessionsListTool(),
    sessionsHistoryTool(),
    sessionsSendTool(),
    sessionsSpawnTool(),
    sessionsYieldTool(),
    updatePlanTool(),
    memorySearchTool(),
    memoryGetTool(),
    memoryAppendTool(),
    browserSnapshotTool(),
    browserClickTool(),
    browserInputTool(),
    browserScrollTool(),
    browserExtractTool(),
  ]);
}

function readTool(): GatewayToolSpec {
  return {
    id: "read",
    sdkName: "read",
    label: "Read",
    description:
      "Read a text file from the workspace. Prefer this over shell.exec/cat for direct file reads.",
    parameters: readParameters,
    source: "core",
    category: "fs",
    risk: "safe",
    idempotent: true,
    needsApproval: (ctx, input) => pathReadApprovalDecision(input, ctx.workspacePath),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "read", input),
  };
}

function writeTool(): GatewayToolSpec {
  return {
    id: "write",
    sdkName: "write",
    label: "Write",
    description: "Create or overwrite a text file.",
    parameters: writeParameters,
    source: "core",
    category: "fs",
    risk: "approval",
    idempotent: false,
    needsApproval: (ctx, input) =>
      pathMutationApprovalDecision("write", input, ctx.workspacePath, ctx.permissionMode),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "write", input),
  };
}

function editTool(): GatewayToolSpec {
  return {
    id: "edit",
    sdkName: "edit",
    label: "Edit",
    description: "Replace text in a file using oldText/newText.",
    parameters: editParameters,
    source: "core",
    category: "fs",
    risk: "approval",
    idempotent: false,
    needsApproval: (ctx, input) =>
      pathMutationApprovalDecision("edit", input, ctx.workspacePath, ctx.permissionMode),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "edit", input),
  };
}

function applyPatchTool(): GatewayToolSpec {
  return {
    id: "apply_patch",
    sdkName: "apply_patch",
    label: "Apply Patch",
    description: "Apply a unified diff patch from cwd.",
    parameters: applyPatchParameters,
    source: "core",
    category: "fs",
    risk: "approval",
    idempotent: false,
    needsApproval: (ctx, input) =>
      applyPatchApprovalDecision(input, ctx.workspacePath, ctx.permissionMode),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "apply_patch", input),
  };
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
    idempotent: false,
    needsApproval: (ctx, input) =>
      shellExecApprovalDecision(input, ctx.workspacePath, ctx.permissionMode),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "shell.exec", input),
  };
}

function processTool(): GatewayToolSpec {
  return {
    id: "process",
    sdkName: "process",
    label: "Process",
    description: "Start, list, read, or stop background processes in the workspace.",
    parameters: processParameters,
    source: "core",
    category: "runtime",
    risk: "approval",
    idempotent: false,
    needsApproval: (ctx, input) => processApprovalDecision(input, ctx.permissionMode),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "process", input),
  };
}

function webSearchTool(): GatewayToolSpec {
  return {
    id: "web_search",
    sdkName: "web_search",
    label: "Web Search",
    description: "Search the web and return a small list of results.",
    parameters: webSearchParameters,
    source: "core",
    category: "web",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "web_search", input),
  };
}

function webFetchTool(): GatewayToolSpec {
  return {
    id: "web_fetch",
    sdkName: "web_fetch",
    label: "Web Fetch",
    description: "Fetch text content from an http(s) URL.",
    parameters: webFetchParameters,
    source: "core",
    category: "web",
    risk: "safe",
    idempotent: true,
    needsApproval: (ctx, input) => webReadApprovalDecision("web_fetch", input, ctx.permissionMode),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "web_fetch", input),
  };
}

function webExtractTool(): GatewayToolSpec {
  return {
    id: "web_extract",
    sdkName: "web_extract",
    label: "Web Extract",
    description: "Fetch an http(s) URL and extract structured page text, title, description, and links.",
    parameters: webExtractParameters,
    source: "core",
    category: "web",
    risk: "safe",
    idempotent: true,
    needsApproval: (ctx, input) => webReadApprovalDecision("web_extract", input, ctx.permissionMode),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "web_extract", input),
  };
}

function sessionsListTool(): GatewayToolSpec {
  return {
    id: "sessions_list",
    sdkName: "sessions_list",
    label: "Sessions List",
    description: "List durable subagent sessions for the current parent run/conversation, optionally filtered.",
    parameters: sessionsListParameters,
    source: "core",
    category: "sessions",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "sessions_list", input),
  };
}

function sessionsHistoryTool(): GatewayToolSpec {
  return {
    id: "sessions_history",
    sdkName: "sessions_history",
    label: "Sessions History",
    description: "Read recent messages from a durable subagent session or conversation.",
    parameters: sessionsHistoryParameters,
    source: "core",
    category: "sessions",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "sessions_history", input),
  };
}

function sessionsSendTool(): GatewayToolSpec {
  return {
    id: "sessions_send",
    sdkName: "sessions_send",
    label: "Sessions Send",
    description: "Send a message to a durable subagent session or conversation and start a run.",
    parameters: sessionsSendParameters,
    source: "core",
    category: "sessions",
    risk: "approval",
    idempotent: false,
    needsApproval: () => ({ needsApproval: true, reason: "sessions_send requires approval" }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "sessions_send", input),
  };
}

function sessionsSpawnTool(): GatewayToolSpec {
  return {
    id: "sessions_spawn",
    sdkName: "sessions_spawn",
    label: "Sessions Spawn",
    description: "Create a durable subagent session under the current run, optionally sending an initial message.",
    parameters: sessionsSpawnParameters,
    source: "core",
    category: "sessions",
    risk: "approval",
    idempotent: false,
    needsApproval: (_ctx, input) => sessionsSpawnApprovalDecision(input),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "sessions_spawn", input),
  };
}

function sessionsYieldTool(): GatewayToolSpec {
  return {
    id: "sessions_yield",
    sdkName: "sessions_yield",
    label: "Sessions Yield",
    description: "Check active durable subagent sessions and child runs for the current parent run/conversation.",
    parameters: sessionsYieldParameters,
    source: "core",
    category: "sessions",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "sessions_yield", input),
  };
}

function updatePlanTool(): GatewayToolSpec {
  return {
    id: "update_plan",
    sdkName: "update_plan",
    label: "Update Plan",
    description: "Publish a short task plan with item statuses.",
    parameters: updatePlanParameters,
    source: "core",
    category: "agents",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "update_plan", input),
  };
}

function memorySearchTool(): GatewayToolSpec {
  return {
    id: "memory_search",
    sdkName: "memory_search",
    label: "Memory Search",
    description: "Search durable Markdown memory for the active agent.",
    parameters: memorySearchParameters,
    source: "core",
    category: "memory",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "memory_search", input),
  };
}

function memoryGetTool(): GatewayToolSpec {
  return {
    id: "memory_get",
    sdkName: "memory_get",
    label: "Memory Get",
    description: "Read a durable memory chunk or memory Markdown file for the active agent.",
    parameters: memoryGetParameters,
    source: "core",
    category: "memory",
    risk: "safe",
    idempotent: true,
    needsApproval: () => ({ needsApproval: false }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "memory_get", input),
  };
}

function memoryAppendTool(): GatewayToolSpec {
  return {
    id: "memory_append",
    sdkName: "memory_append",
    label: "Memory Append",
    description: "Append approved durable memory to MEMORY.md or memory/YYYY-MM-DD.md.",
    parameters: memoryAppendParameters,
    source: "core",
    category: "memory",
    risk: "approval",
    idempotent: false,
    needsApproval: () => ({ needsApproval: true, reason: "memory_append requires approval" }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "memory_append", input),
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
    idempotent: true,
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
    idempotent: false,
    needsApproval: () => ({
      needsApproval: true,
      reason: "browser.click requires browser approval",
    }),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "browser.click", input),
  };
}

function browserInputTool(): GatewayToolSpec {
  return {
    id: "browser.input",
    sdkName: "browser_input",
    label: "Browser Input",
    description: "Set text into an element by selector in the browser.",
    parameters: browserInputParameters,
    source: "core",
    category: "browser",
    risk: "approval",
    idempotent: false,
    needsApproval: () => browserApprovalDecision("browser.input"),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "browser.input", input),
  };
}

function browserScrollTool(): GatewayToolSpec {
  return {
    id: "browser.scroll",
    sdkName: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the current browser page or a selected element.",
    parameters: browserScrollParameters,
    source: "core",
    category: "browser",
    risk: "approval",
    idempotent: false,
    needsApproval: () => browserApprovalDecision("browser.scroll"),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "browser.scroll", input),
  };
}

function browserExtractTool(): GatewayToolSpec {
  return {
    id: "browser.extract",
    sdkName: "browser_extract",
    label: "Browser Extract",
    description: "Extract visible text and links from the current browser tab.",
    parameters: browserExtractParameters,
    source: "core",
    category: "browser",
    risk: "approval",
    idempotent: true,
    needsApproval: () => browserApprovalDecision("browser.extract"),
    execute: (ctx, input) => executeViaGatewayTool(ctx, "browser.extract", input),
  };
}

function browserApprovalDecision(toolName: string): GatewayToolApprovalDecision {
  return {
    needsApproval: true,
    reason: `${toolName} requires browser approval`,
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
    permissionMode: ctx.permissionMode,
    approvalToken: ctx.approvalToken,
  });
}

export function coreToolApprovalDecision(
  toolName: string,
  input: unknown,
  workspacePath: string | undefined,
  permissionMode: ConversationPermissionMode = "default",
): GatewayToolApprovalDecision {
  switch (toolName) {
    case "read":
      return pathReadApprovalDecision(input, workspacePath);
    case "write":
      return pathMutationApprovalDecision("write", input, workspacePath, permissionMode);
    case "edit":
      return pathMutationApprovalDecision("edit", input, workspacePath, permissionMode);
    case "apply_patch":
      return applyPatchApprovalDecision(input, workspacePath, permissionMode);
    case "process":
      return processApprovalDecision(input, permissionMode);
    case "web_search":
      return { needsApproval: false };
    case "web_fetch":
      return webReadApprovalDecision("web_fetch", input, permissionMode);
    case "web_extract":
      return webReadApprovalDecision("web_extract", input, permissionMode);
    case "sessions_send":
      return { needsApproval: true, reason: "sessions_send requires approval" };
    case "sessions_spawn":
      return sessionsSpawnApprovalDecision(input);
    case "memory_append":
      return { needsApproval: true, reason: "memory_append requires approval" };
    case "browser.snapshot":
    case "browser.click":
    case "browser.input":
    case "browser.scroll":
    case "browser.extract":
      return browserApprovalDecision(toolName);
    case "shell.exec":
      return shellExecApprovalDecision(input, workspacePath, permissionMode);
    default:
      return { needsApproval: false };
  }
}

function sessionsSpawnApprovalDecision(input: unknown): GatewayToolApprovalDecision {
  const value = isObjectRecord(input) ? input : {};
  const label = stringField(value, "label") || stringField(value, "agentId") || "子智能体";
  const title = stringField(value, "title") || stringField(value, "message");
  return {
    needsApproval: true,
    reason: title ? `建议开启子智能体 ${label}：${title}` : `建议开启子智能体 ${label}`,
  };
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (typeof field !== "string") return undefined;
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathReadApprovalDecision(
  input: unknown,
  workspacePath: string | undefined,
): GatewayToolApprovalDecision {
  const value = input as { path?: unknown };
  if (typeof value.path !== "string") {
    return { needsApproval: true, reason: "read missing path" };
  }
  if (!workspacePath) {
    return { needsApproval: true, reason: "read outside known workspace" };
  }
  const workspaceRoot = path.resolve(workspacePath);
  const filePath = path.resolve(workspaceRoot, value.path);
  if (!isInsidePath(filePath, workspaceRoot)) {
    return { needsApproval: true, reason: "read outside workspace" };
  }
  return { needsApproval: false };
}

function pathMutationApprovalDecision(
  toolName: "write" | "edit",
  input: unknown,
  workspacePath: string | undefined,
  permissionMode: ConversationPermissionMode | undefined,
): GatewayToolApprovalDecision {
  if (permissionMode === "read_only") {
    return { needsApproval: true, reason: `${toolName} requires approval in read-only mode` };
  }
  const value = input as { path?: unknown };
  if (typeof value.path !== "string") {
    return { needsApproval: true, reason: `${toolName} missing path` };
  }
  return pathWorkspaceApprovalDecision(toolName, value.path, workspacePath);
}

function applyPatchApprovalDecision(
  input: unknown,
  workspacePath: string | undefined,
  permissionMode: ConversationPermissionMode | undefined,
): GatewayToolApprovalDecision {
  if (permissionMode === "read_only") {
    return { needsApproval: true, reason: "apply_patch requires approval in read-only mode" };
  }
  const value = input as { cwd?: unknown };
  if (typeof value.cwd !== "string") {
    return { needsApproval: true, reason: "apply_patch missing cwd" };
  }
  return pathWorkspaceApprovalDecision("apply_patch", value.cwd, workspacePath);
}

function pathWorkspaceApprovalDecision(
  toolName: string,
  targetPath: string,
  workspacePath: string | undefined,
): GatewayToolApprovalDecision {
  if (!workspacePath) {
    return { needsApproval: true, reason: `${toolName} outside known workspace` };
  }
  const workspaceRoot = path.resolve(workspacePath);
  const resolved = path.resolve(workspaceRoot, targetPath);
  if (!isInsidePath(resolved, workspaceRoot)) {
    return { needsApproval: true, reason: `${toolName} outside workspace` };
  }
  return { needsApproval: false };
}

function processApprovalDecision(
  input: unknown,
  permissionMode: ConversationPermissionMode | undefined,
): GatewayToolApprovalDecision {
  if (permissionMode === "read_only") {
    return { needsApproval: true, reason: "process requires approval in read-only mode" };
  }
  const value = input as { action?: unknown };
  if (value.action === "start" || value.action === "stop") {
    return { needsApproval: true, reason: `process ${value.action} requires approval` };
  }
  return { needsApproval: false };
}

function webReadApprovalDecision(
  toolName: "web_fetch" | "web_extract",
  input: unknown,
  _permissionMode: ConversationPermissionMode | undefined,
): GatewayToolApprovalDecision {
  const value = input as { url?: unknown };
  if (typeof value.url !== "string") {
    return { needsApproval: true, reason: `${toolName} missing url` };
  }
  try {
    const url = new URL(value.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { needsApproval: true, reason: `${toolName} requires http(s)` };
    }
    if (isPrivateHostname(url.hostname)) {
      return { needsApproval: true, reason: `${toolName} targets a private host` };
    }
  } catch {
    return { needsApproval: true, reason: `${toolName} invalid url` };
  }
  return { needsApproval: false };
}

function shellExecApprovalDecision(
  input: unknown,
  workspacePath: string | undefined,
  permissionMode: ConversationPermissionMode | undefined,
): GatewayToolApprovalDecision {
  if (permissionMode === "read_only") {
    return { needsApproval: true, reason: "shell.exec requires approval in read-only mode" };
  }
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

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}
