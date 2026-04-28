import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ToolCallError, type ToolCallable } from "@vulture/agent-runtime";
import type { PartialRunEvent } from "../domain/runStore";
import type { AppError } from "@vulture/protocol/src/v1/error";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const LOCAL_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "process",
  "web_search",
  "web_fetch",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "update_plan",
  "memory_search",
  "memory_get",
  "memory_append",
]);
const MAX_TEXT_BYTES = 256_000;
const MAX_PROCESS_BUFFER = 64_000;

export interface GatewaySessionsTools {
  list(input: unknown): unknown;
  history(input: unknown): unknown;
  send(input: unknown): Promise<unknown>;
  spawn(input: unknown): Promise<unknown>;
  yield(input: unknown): unknown;
}

export interface GatewayMemoryTools {
  search(call: Parameters<ToolCallable>[0]): Promise<unknown>;
  get(call: Parameters<ToolCallable>[0]): Promise<unknown>;
  append(call: Parameters<ToolCallable>[0]): Promise<unknown>;
}

export interface GatewayLocalToolsOptions {
  shellTools: ToolCallable;
  appendEvent?: (runId: string, partial: PartialRunEvent) => void;
  fetch?: FetchLike;
  sessions?: GatewaySessionsTools;
  memory?: GatewayMemoryTools;
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
  const f = opts.fetch ?? fetch;

  return async (call) => {
    if (!LOCAL_TOOL_NAMES.has(call.tool)) return opts.shellTools(call);
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
        fetch: f,
        sessions: opts.sessions,
        memory: opts.memory,
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
    fetch: FetchLike;
    sessions?: GatewaySessionsTools;
    memory?: GatewayMemoryTools;
  },
): Promise<unknown> {
  switch (call.tool) {
    case "read":
      return readTool(call);
    case "write":
      requireApproval(call, "write requires approval");
      return writeTool(call);
    case "edit":
      requireApproval(call, "edit requires approval");
      return editTool(call);
    case "apply_patch":
      requireApproval(call, "apply_patch requires approval");
      return applyPatchTool(call);
    case "process":
      return processTool(call, deps.processStore);
    case "web_fetch":
      return webFetchTool(call, deps.fetch);
    case "web_search":
      return webSearchTool(call, deps.fetch);
    case "sessions_list":
      return wrapItems(requireSessions(deps).list(call.input));
    case "sessions_history":
      return wrapItems(requireSessions(deps).history(call.input));
    case "sessions_send":
      requireApproval(call, "sessions_send requires approval");
      return requireSessions(deps).send(call.input);
    case "sessions_spawn":
      requireApproval(call, "sessions_spawn requires approval");
      return requireSessions(deps).spawn(call.input);
    case "sessions_yield":
      return requireSessions(deps).yield(call.input);
    case "update_plan":
      return updatePlanTool(call);
    case "memory_search":
      return requireMemory(deps).search(call);
    case "memory_get":
      return requireMemory(deps).get(call);
    case "memory_append":
      requireApproval(call, "memory_append requires approval");
      return requireMemory(deps).append(call);
    default:
      throw new ToolCallError("tool.execution_failed", `unknown local tool ${call.tool}`);
  }
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
      return { items: [...store.values()].map((record) => summarizeProcess(record)) };
    case "read": {
      const record = getProcess(store, input.processId);
      return summarizeProcess(record, true);
    }
    case "stop": {
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
  f: FetchLike,
): Promise<unknown> {
  const input = call.input as { url?: unknown; maxBytes?: unknown };
  const url = parseHttpUrl(input.url, call.approvalToken);
  const res = await f(url);
  const text = await res.text();
  const maxBytes = typeof input.maxBytes === "number" ? input.maxBytes : MAX_TEXT_BYTES;
  const content = truncateUtf8(text, maxBytes);
  return {
    url: typeof input.url === "string" ? input.url : url,
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    content,
    truncated: Buffer.byteLength(text) > maxBytes,
  };
}

function wrapItems(value: unknown): unknown {
  return Array.isArray(value) ? { items: value } : value;
}

async function webSearchTool(
  call: Parameters<ToolCallable>[0],
  f: FetchLike,
): Promise<unknown> {
  const input = call.input as { query?: unknown; limit?: unknown };
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new ToolCallError("tool.execution_failed", "web_search missing query");
  }
  const limit = Math.min(typeof input.limit === "number" ? input.limit : 5, 10);
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
  const res = await f(url, {
    headers: {
      "User-Agent": "Vulture/1.0",
    },
  });
  const html = await res.text();
  return { query: input.query, results: parseDuckDuckGoResults(html).slice(0, limit) };
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

function parseHttpUrl(value: unknown, approvalToken?: string): string {
  if (typeof value !== "string") {
    throw new ToolCallError("tool.execution_failed", "web_fetch missing url");
  }
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolCallError("tool.permission_denied", "web_fetch requires http(s)");
  }
  if (isPrivateHostname(url.hostname) && !approvalToken) {
    throw new ToolCallError("tool.permission_denied", "web_fetch private host requires approval");
  }
  return url.toString();
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

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  return buffer.byteLength <= maxBytes ? value : buffer.subarray(0, maxBytes).toString("utf8");
}

function parseDuckDuckGoResults(html: string): Array<{ title: string; url: string }> {
  const results: Array<{ title: string; url: string }> = [];
  const pattern = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  for (const match of html.matchAll(pattern)) {
    const url = decodeHtml(match[1] ?? "");
    const title = decodeHtml(stripTags(match[2] ?? "")).trim();
    if (url && title) results.push({ title, url });
  }
  return results;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
