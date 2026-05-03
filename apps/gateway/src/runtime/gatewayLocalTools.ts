import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ToolCallError, type ToolCallable } from "@vulture/agent-runtime";
import type { PartialRunEvent } from "../domain/runStore";
import type { AppError } from "@vulture/protocol/src/v1/error";
import {
  createWebAccessService,
  type FetchLike,
  type WebAccessService,
} from "./webAccess";
import { runGrep } from "./grep";
import { runGlob } from "./glob";
import type { LspClientManager } from "./lspClientManager";

const LOCAL_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "process",
  "web_search",
  "web_fetch",
  "web_extract",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "update_plan",
  "memory_search",
  "memory_get",
  "memory_append",
  "grep",
  "glob",
  "lsp.diagnostics",
  "lsp.definition",
  "lsp.references",
  "lsp.hover",
]);
const MAX_TEXT_BYTES = 256_000;
const MAX_PROCESS_BUFFER = 64_000;

export interface GatewaySessionsTools {
  list(call: Parameters<ToolCallable>[0]): unknown;
  history(call: Parameters<ToolCallable>[0]): unknown;
  send(call: Parameters<ToolCallable>[0]): Promise<unknown>;
  spawn(call: Parameters<ToolCallable>[0]): Promise<unknown>;
  yield(call: Parameters<ToolCallable>[0]): unknown;
}

export interface GatewayMemoryTools {
  search(call: Parameters<ToolCallable>[0]): Promise<unknown>;
  get(call: Parameters<ToolCallable>[0]): Promise<unknown>;
  append(call: Parameters<ToolCallable>[0]): Promise<unknown>;
}

export interface GatewayMcpTools {
  canHandle(toolName: string): boolean;
  execute(call: Parameters<ToolCallable>[0]): Promise<unknown>;
}

export interface GatewayLocalToolsOptions {
  shellTools: ToolCallable;
  appendEvent?: (runId: string, partial: PartialRunEvent) => void;
  fetch?: FetchLike;
  webAccess?: WebAccessService;
  sessions?: GatewaySessionsTools;
  memory?: GatewayMemoryTools;
  mcp?: GatewayMcpTools;
  lspManager?: LspClientManager;
}

interface ManagedProcess {
  processId: string;
  child: ChildProcess;
  argv: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  endedAt: string | null;
}

export function makeGatewayLocalTools(opts: GatewayLocalToolsOptions): ToolCallable {
  const processStore = new Map<string, ManagedProcess>();
  const webAccess = opts.webAccess ?? createWebAccessService({ fetch: opts.fetch ?? fetch });

  return async (call) => {
    const isMcpTool = opts.mcp?.canHandle(call.tool) ?? false;
    if (!LOCAL_TOOL_NAMES.has(call.tool) && !isMcpTool) return opts.shellTools(call);
    opts.appendEvent?.(call.runId, {
      type: "tool.planned",
      callId: call.callId,
      tool: call.tool,
      input: call.input,
    });
    opts.appendEvent?.(call.runId, { type: "tool.started", callId: call.callId });
    try {
      const output = await executeLocalTool(call, {
        processStore,
        webAccess,
        sessions: opts.sessions,
        memory: opts.memory,
        mcp: opts.mcp,
        lspManager: opts.lspManager,
      });
      opts.appendEvent?.(call.runId, {
        type: "tool.completed",
        callId: call.callId,
        output,
      });
      return output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err instanceof ToolCallError ? err.code : "tool.execution_failed") as AppError["code"];
      opts.appendEvent?.(call.runId, {
        type: "tool.failed",
        callId: call.callId,
        error: { code, message },
      });
      if (err instanceof ToolCallError) throw err;
      throw new ToolCallError(code, message);
    }
  };
}

async function executeLocalTool(
  call: Parameters<ToolCallable>[0],
  deps: {
    processStore: Map<string, ManagedProcess>;
    webAccess: WebAccessService;
    sessions?: GatewaySessionsTools;
    memory?: GatewayMemoryTools;
    mcp?: GatewayMcpTools;
    lspManager?: LspClientManager;
  },
): Promise<unknown> {
  if (deps.mcp?.canHandle(call.tool)) {
    return deps.mcp.execute(call);
  }
  switch (call.tool) {
    case "read":
      return readTool(call);
    case "write":
      requireWorkspaceMutationPermission(call, "write", inputPath(call.input));
      return writeTool(call);
    case "edit":
      requireWorkspaceMutationPermission(call, "edit", inputPath(call.input));
      return editTool(call);
    case "apply_patch":
      requireWorkspaceMutationPermission(call, "apply_patch", inputCwd(call.input));
      return applyPatchTool(call);
    case "process":
      return processTool(call, deps.processStore);
    case "web_fetch":
      return webFetchTool(call, deps.webAccess);
    case "web_extract":
      return webExtractTool(call, deps.webAccess);
    case "web_search":
      return webSearchTool(call, deps.webAccess);
    case "sessions_list":
      return wrapItems(requireSessions(deps).list(call));
    case "sessions_history":
      return wrapItems(requireSessions(deps).history(call));
    case "sessions_send":
      requireApproval(call, "sessions_send requires approval");
      return requireSessions(deps).send(call);
    case "sessions_spawn":
      requireApproval(call, sessionsSpawnApprovalReason(call.input));
      return requireSessions(deps).spawn(call);
    case "sessions_yield":
      return requireSessions(deps).yield(call);
    case "update_plan":
      return updatePlanTool(call);
    case "memory_search":
      return requireMemory(deps).search(call);
    case "memory_get":
      return requireMemory(deps).get(call);
    case "memory_append":
      requireApproval(call, "memory_append requires approval");
      return requireMemory(deps).append(call);
    case "grep": {
      const input = call.input as {
        pattern: string;
        path?: string;
        glob?: string;
        regex?: boolean;
        caseSensitive?: boolean;
        maxMatches?: number;
      };
      return await runGrep({
        pattern: input.pattern,
        path: input.path ?? call.workspacePath,
        glob: input.glob,
        regex: input.regex ?? false,
        caseSensitive: input.caseSensitive ?? false,
        maxMatches: input.maxMatches ?? undefined,
      });
    }
    case "glob": {
      const input = call.input as { pattern: string; path?: string; maxResults?: number };
      return await runGlob({
        pattern: input.pattern,
        path: input.path ?? call.workspacePath,
        maxResults: input.maxResults ?? undefined,
      });
    }
    case "lsp.diagnostics":
    case "lsp.definition":
    case "lsp.references":
    case "lsp.hover": {
      if (!deps.lspManager) {
        throw new ToolCallError("lsp.unavailable", "LSP manager not configured");
      }
      const input = call.input as {
        filePath: string;
        line?: number;
        character?: number;
        includeDeclaration?: boolean;
      };
      const root = call.workspacePath ?? "";
      let result;
      if (call.tool === "lsp.diagnostics") {
        result = await deps.lspManager.diagnostics(root, input.filePath);
      } else if (call.tool === "lsp.definition") {
        result = await deps.lspManager.definition(root, input.filePath, input.line ?? 0, input.character ?? 0);
      } else if (call.tool === "lsp.references") {
        result = await deps.lspManager.references(root, input.filePath, input.line ?? 0, input.character ?? 0, input.includeDeclaration ?? true);
      } else {
        result = await deps.lspManager.hover(root, input.filePath, input.line ?? 0, input.character ?? 0);
      }
      return mapLspResult(result);
    }
    default:
      throw new ToolCallError("tool.execution_failed", `unknown local tool ${call.tool}`);
  }
}

function mapLspResult(result: { kind: "ok"; value: unknown } | { kind: "error"; error: unknown }): unknown {
  if (result.kind === "ok") return result.value;
  return { error: result.error };
}

async function readTool(call: Parameters<ToolCallable>[0]): Promise<unknown> {
  const input = call.input as { path?: unknown; maxBytes?: unknown };
  const filePath = resolveToolPath(call.workspacePath, input.path);
  if (!isInsideWorkspace(filePath, call.workspacePath)) {
    requireApproval(call, "read outside workspace requires approval");
  }
  const maxBytes = typeof input.maxBytes === "number" ? input.maxBytes : MAX_TEXT_BYTES;
  const buffer = await readFile(filePath);
  const truncated = buffer.byteLength > maxBytes;
  const content = buffer.subarray(0, maxBytes).toString("utf8");
  return { path: filePath, content, bytes: buffer.byteLength, truncated };
}

async function writeTool(call: Parameters<ToolCallable>[0]): Promise<unknown> {
  const input = call.input as { path?: unknown; content?: unknown };
  if (typeof input.content !== "string") {
    throw new ToolCallError("tool.execution_failed", "write missing content");
  }
  const filePath = resolveToolPath(call.workspacePath, input.path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, input.content, "utf8");
  return { path: filePath, bytes: Buffer.byteLength(input.content) };
}

async function editTool(call: Parameters<ToolCallable>[0]): Promise<unknown> {
  const input = call.input as {
    path?: unknown;
    oldText?: unknown;
    newText?: unknown;
    replaceAll?: unknown;
  };
  if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
    throw new ToolCallError("tool.execution_failed", "edit missing oldText/newText");
  }
  const filePath = resolveToolPath(call.workspacePath, input.path);
  const current = await readFile(filePath, "utf8");
  if (!current.includes(input.oldText)) {
    throw new ToolCallError("tool.execution_failed", "edit oldText not found");
  }
  const next =
    input.replaceAll === true
      ? current.split(input.oldText).join(input.newText)
      : current.replace(input.oldText, input.newText);
  await writeFile(filePath, next, "utf8");
  return {
    path: filePath,
    replacements: input.replaceAll === true ? current.split(input.oldText).length - 1 : 1,
  };
}

async function applyPatchTool(call: Parameters<ToolCallable>[0]): Promise<unknown> {
  const input = call.input as { cwd?: unknown; patch?: unknown };
  if (typeof input.patch !== "string") {
    throw new ToolCallError("tool.execution_failed", "apply_patch missing patch");
  }
  const cwd = resolveToolPath(call.workspacePath, input.cwd);
  const result = await runProcess({
    cwd,
    argv: ["git", "apply", "--whitespace=nowarn", "-"],
    stdin: input.patch,
  });
  if (result.exitCode !== 0) {
    throw new ToolCallError(
      "tool.execution_failed",
      result.stderr || result.stdout || "git apply failed",
    );
  }
  return { cwd, stdout: result.stdout, stderr: result.stderr };
}

async function processTool(
  call: Parameters<ToolCallable>[0],
  store: Map<string, ManagedProcess>,
): Promise<unknown> {
  const input = call.input as {
    action?: unknown;
    processId?: unknown;
    cwd?: unknown;
    argv?: unknown;
  };
  switch (input.action) {
    case "start": {
      if (call.permissionMode === "read_only") {
        requireApproval(call, "process requires approval in read-only mode");
      }
      requireApproval(call, "process start requires approval");
      const cwd = resolveToolPath(call.workspacePath, input.cwd);
      if (!isInsideWorkspace(cwd, call.workspacePath)) {
        requireApproval(call, "process start outside workspace requires approval");
      }
      if (!Array.isArray(input.argv) || input.argv.length === 0) {
        throw new ToolCallError("tool.execution_failed", "process start missing argv");
      }
      const argv = input.argv.map(String);
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const processId = `p-${crypto.randomUUID()}`;
      const record: ManagedProcess = {
        processId,
        child,
        argv,
        cwd,
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
      };
      child.stdout.on("data", (chunk) => {
        record.stdout = appendBounded(record.stdout, chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk) => {
        record.stderr = appendBounded(record.stderr, chunk.toString("utf8"));
      });
      child.on("exit", (code, signal) => {
        record.exitCode = code;
        record.signal = signal;
        record.endedAt = new Date().toISOString();
      });
      store.set(processId, record);
      return summarizeProcess(record);
    }
    case "list":
      if (call.permissionMode === "read_only") {
        requireApproval(call, "process requires approval in read-only mode");
      }
      return { items: [...store.values()].map((record) => summarizeProcess(record)) };
    case "read": {
      if (call.permissionMode === "read_only") {
        requireApproval(call, "process requires approval in read-only mode");
      }
      const record = getProcess(store, input.processId);
      return summarizeProcess(record, true);
    }
    case "stop": {
      if (call.permissionMode === "read_only") {
        requireApproval(call, "process requires approval in read-only mode");
      }
      requireApproval(call, "process stop requires approval");
      const record = getProcess(store, input.processId);
      const killed = record.child.kill();
      return { ...summarizeProcess(record, true), killed };
    }
    default:
      throw new ToolCallError("tool.execution_failed", "process action must be start/list/read/stop");
  }
}

async function webFetchTool(
  call: Parameters<ToolCallable>[0],
  webAccess: WebAccessService,
): Promise<unknown> {
  const input = call.input as { url?: unknown; maxBytes?: unknown };
  return webAccess.fetch({
    url: input.url,
    maxBytes: typeof input.maxBytes === "number" ? input.maxBytes : MAX_TEXT_BYTES,
    approvalToken: call.approvalToken,
  });
}

async function webExtractTool(
  call: Parameters<ToolCallable>[0],
  webAccess: WebAccessService,
): Promise<unknown> {
  const input = call.input as { url?: unknown; maxBytes?: unknown; maxLinks?: unknown };
  return webAccess.extract({
    url: input.url,
    maxBytes: typeof input.maxBytes === "number" ? input.maxBytes : MAX_TEXT_BYTES,
    maxLinks: typeof input.maxLinks === "number" ? input.maxLinks : null,
    approvalToken: call.approvalToken,
  });
}

function wrapItems(value: unknown): unknown {
  return Array.isArray(value) ? { items: value } : value;
}

async function webSearchTool(
  call: Parameters<ToolCallable>[0],
  webAccess: WebAccessService,
): Promise<unknown> {
  const input = call.input as { query?: unknown; limit?: unknown };
  return webAccess.search({
    query: typeof input.query === "string" ? input.query : "",
    limit: typeof input.limit === "number" ? input.limit : null,
  });
}

function updatePlanTool(call: Parameters<ToolCallable>[0]): unknown {
  const input = call.input as { items?: unknown };
  if (!Array.isArray(input.items)) {
    throw new ToolCallError("tool.execution_failed", "update_plan missing items");
  }
  const items = input.items.map((item) => {
    const value = item as { step?: unknown; status?: unknown };
    if (
      typeof value.step !== "string" ||
      !["pending", "in_progress", "completed"].includes(String(value.status))
    ) {
      throw new ToolCallError("tool.execution_failed", "invalid update_plan item");
    }
    return { step: value.step, status: value.status };
  });
  return { items };
}

function requireSessions(deps: { sessions?: GatewaySessionsTools }): GatewaySessionsTools {
  if (!deps.sessions) {
    throw new ToolCallError("tool.execution_failed", "sessions tools are not configured");
  }
  return deps.sessions;
}

function requireMemory(deps: { memory?: GatewayMemoryTools }): GatewayMemoryTools {
  if (!deps.memory) {
    throw new ToolCallError("tool.execution_failed", "memory tools are not configured");
  }
  return deps.memory;
}

function requireApproval(call: Parameters<ToolCallable>[0], message: string): void {
  if (!call.approvalToken) {
    throw new ToolCallError("tool.permission_denied", message);
  }
}

function requireWorkspaceMutationPermission(
  call: Parameters<ToolCallable>[0],
  toolName: "write" | "edit" | "apply_patch",
  targetPath: unknown,
): void {
  if (call.permissionMode === "full_access") return;
  if (call.permissionMode === "read_only") {
    requireApproval(call, `${toolName} requires approval in read-only mode`);
    return;
  }
  const filePath = resolveToolPath(call.workspacePath, targetPath);
  if (!isInsideWorkspace(filePath, call.workspacePath)) {
    requireApproval(call, `${toolName} outside workspace`);
  }
}

function inputPath(input: unknown): unknown {
  return (input as { path?: unknown }).path;
}

function inputCwd(input: unknown): unknown {
  return (input as { cwd?: unknown }).cwd;
}

function sessionsSpawnApprovalReason(input: unknown): string {
  const value = isRecord(input) ? input : {};
  const label = stringField(value, "label") || stringField(value, "agentId") || "子智能体";
  const title = stringField(value, "title") || stringField(value, "message");
  return title ? `建议开启子智能体 ${label}：${title}` : `建议开启子智能体 ${label}`;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (typeof field !== "string") return undefined;
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveToolPath(workspacePath: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolCallError("tool.execution_failed", "path is required");
  }
  return isAbsolute(value) ? resolve(value) : resolve(workspacePath, value);
}

function isInsideWorkspace(path: string, workspacePath: string): boolean {
  const rel = relative(resolve(workspacePath), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function getProcess(store: Map<string, ManagedProcess>, processId: unknown): ManagedProcess {
  if (typeof processId !== "string") {
    throw new ToolCallError("tool.execution_failed", "processId is required");
  }
  const record = store.get(processId);
  if (!record) {
    throw new ToolCallError("tool.execution_failed", `unknown process ${processId}`);
  }
  return record;
}

function summarizeProcess(record: ManagedProcess, includeOutput = false): Record<string, unknown> {
  return {
    processId: record.processId,
    pid: record.child.pid ?? null,
    argv: record.argv,
    cwd: record.cwd,
    status: record.endedAt ? "exited" : "running",
    exitCode: record.exitCode,
    signal: record.signal,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    ...(includeOutput ? { stdout: record.stdout, stderr: record.stderr } : {}),
  };
}

function appendBounded(current: string, next: string): string {
  const value = current + next;
  return value.length <= MAX_PROCESS_BUFFER ? value : value.slice(-MAX_PROCESS_BUFFER);
}

async function runProcess(opts: {
  cwd: string;
  argv: string[];
  stdin?: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(opts.argv[0]!, opts.argv.slice(1), {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk.toString("utf8"));
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
    child.stdin.end(opts.stdin ?? "");
  });
}
