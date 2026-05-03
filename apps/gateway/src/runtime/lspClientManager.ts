import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { LspServerHandle, type LspLanguage, type LspTransport } from "./lspServerHandle";

export interface LspError {
  code:
    | "lsp.unsupported_language"
    | "lsp.no_project_config"
    | "lsp.server_not_found"
    | "lsp.indexing"
    | "lsp.path_outside_workspace";
  message: string;
  install_hint?: string;
}

export type LspResult<T> = { kind: "ok"; value: T } | { kind: "error"; error: LspError };

export interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
export interface Diagnostic {
  range: Range;
  severity: number;
  message: string;
  source?: string;
}
export interface Location {
  filePath: string;
  range: Range;
}
export interface HoverContent {
  contents: string;
  range: Range | null;
}

export interface LspClientManager {
  diagnostics(root: string, filePath: string): Promise<LspResult<Diagnostic[]>>;
  definition(root: string, filePath: string, line: number, character: number): Promise<LspResult<Location[]>>;
  references(root: string, filePath: string, line: number, character: number, includeDecl: boolean): Promise<LspResult<Location[]>>;
  hover(root: string, filePath: string, line: number, character: number): Promise<LspResult<HoverContent | null>>;
  cacheSize(): number;
  dispose(): Promise<void>;
}

export interface LspClientManagerOptions {
  idleTtlMs?: number;
  sweepIntervalMs?: number;
  transportFactory: (root: string, language: LspLanguage) => Promise<LspTransport | null>;
}

const DEFAULT_IDLE_TTL = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL = 60 * 1000;
const DISPATCH_TIMEOUT_MS = 30_000;

export function detectLanguage(filePath: string): LspLanguage | null {
  const ext = extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
  if (ext === ".rs") return "rust";
  return null;
}

export function projectConfigExists(root: string, language: LspLanguage): boolean {
  if (language === "typescript") {
    return existsSync(join(root, "tsconfig.json")) || existsSync(join(root, "jsconfig.json"));
  }
  if (language === "rust") {
    return existsSync(join(root, "Cargo.toml"));
  }
  return false;
}

export function createLspClientManager(opts: LspClientManagerOptions): LspClientManager {
  const ttl = opts.idleTtlMs ?? DEFAULT_IDLE_TTL;
  const sweep = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL;
  const handles = new Map<string, LspServerHandle>();

  const sweeper = setInterval(async () => {
    const now = Date.now();
    for (const [key, handle] of handles) {
      if (now - handle.lastUsedAt > ttl) {
        handles.delete(key);
        await handle.dispose().catch(() => {});
      }
    }
  }, sweep);
  if ("unref" in sweeper) (sweeper as { unref: () => void }).unref();

  async function getHandle(root: string, language: LspLanguage): Promise<LspResult<LspServerHandle>> {
    const key = `${root}::${language}`;
    const existing = handles.get(key);
    if (existing) {
      existing.touch();
      return { kind: "ok", value: existing };
    }
    if (!projectConfigExists(root, language)) {
      return {
        kind: "error",
        error: {
          code: "lsp.no_project_config",
          message: `No ${language === "typescript" ? "tsconfig.json/jsconfig.json" : "Cargo.toml"} at ${root}`,
        },
      };
    }
    const transport = await opts.transportFactory(root, language);
    if (!transport) {
      return {
        kind: "error",
        error: {
          code: "lsp.server_not_found",
          message: `${language === "typescript" ? "typescript-language-server" : "rust-analyzer"} not found on PATH`,
          install_hint:
            language === "typescript"
              ? "npm install -g typescript-language-server typescript"
              : "rustup component add rust-analyzer",
        },
      };
    }
    const handle = new LspServerHandle(transport, root, language);
    await handle.ready();
    handles.set(key, handle);
    return { kind: "ok", value: handle };
  }

  function preflight(root: string, filePath: string): LspResult<{ language: LspLanguage }> {
    if (!filePath.startsWith(root)) {
      return { kind: "error", error: { code: "lsp.path_outside_workspace", message: filePath } };
    }
    const language = detectLanguage(filePath);
    if (!language) {
      return { kind: "error", error: { code: "lsp.unsupported_language", message: filePath } };
    }
    return { kind: "ok", value: { language } };
  }

  async function dispatch<T>(
    root: string,
    filePath: string,
    languageId: string,
    method: string,
    params: (uri: string) => unknown,
    convert: (raw: unknown) => T,
  ): Promise<LspResult<T>> {
    const pre = preflight(root, filePath);
    if (pre.kind === "error") return pre;
    const handle = await getHandle(root, pre.value.language);
    if (handle.kind === "error") return handle;
    await handle.value.ensureOpen(filePath, languageId);
    const uri = `file://${filePath}`;
    let raw: unknown;
    try {
      raw = await Promise.race([
        handle.value.send(method, params(uri)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), DISPATCH_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      return {
        kind: "error",
        error: { code: "lsp.indexing", message: (err as Error).message },
      };
    }
    return { kind: "ok", value: convert(raw) };
  }

  function langId(language: LspLanguage): string {
    return language === "typescript" ? "typescript" : "rust";
  }

  return {
    diagnostics: (root, filePath) =>
      dispatch(
        root,
        filePath,
        langId(detectLanguage(filePath) ?? "typescript"),
        "textDocument/diagnostic",
        (uri) => ({ textDocument: { uri } }),
        (raw) => ((raw as { items?: Diagnostic[] })?.items ?? []) as Diagnostic[],
      ),
    definition: (root, filePath, line, character) =>
      dispatch(
        root,
        filePath,
        langId(detectLanguage(filePath) ?? "typescript"),
        "textDocument/definition",
        (uri) => ({ textDocument: { uri }, position: { line, character } }),
        (raw) => normalizeLocations(raw),
      ),
    references: (root, filePath, line, character, includeDecl) =>
      dispatch(
        root,
        filePath,
        langId(detectLanguage(filePath) ?? "typescript"),
        "textDocument/references",
        (uri) => ({
          textDocument: { uri },
          position: { line, character },
          context: { includeDeclaration: includeDecl },
        }),
        (raw) => normalizeLocations(raw),
      ),
    hover: (root, filePath, line, character) =>
      dispatch(
        root,
        filePath,
        langId(detectLanguage(filePath) ?? "typescript"),
        "textDocument/hover",
        (uri) => ({ textDocument: { uri }, position: { line, character } }),
        (raw) => normalizeHover(raw),
      ),
    cacheSize: () => handles.size,
    dispose: async () => {
      clearInterval(sweeper);
      for (const handle of handles.values()) {
        await handle.dispose().catch(() => {});
      }
      handles.clear();
    },
  };
}

function normalizeLocations(raw: unknown): Location[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((loc) => ({
    filePath: ((loc as { uri: string }).uri ?? "").replace(/^file:\/\//, ""),
    range: (loc as { range: Range }).range,
  }));
}

function normalizeHover(raw: unknown): HoverContent | null {
  if (!raw) return null;
  const r = raw as { contents?: unknown; range?: Range };
  let contents = "";
  if (typeof r.contents === "string") contents = r.contents;
  else if (Array.isArray(r.contents)) {
    contents = r.contents
      .map((c) => (typeof c === "string" ? c : (c as { value: string }).value))
      .join("\n");
  } else if (typeof r.contents === "object" && r.contents !== null && "value" in r.contents) {
    contents = (r.contents as { value: string }).value;
  }
  return { contents, range: r.range ?? null };
}
