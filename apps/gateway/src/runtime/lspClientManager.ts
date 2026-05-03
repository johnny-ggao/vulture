import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import {
  LspServerHandle,
  pathToFileUri,
  type LspLanguage,
  type LspTransport,
} from "./lspServerHandle";
import { isPathInside } from "./skills";

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

function langIdFor(language: LspLanguage): string {
  return language === "typescript" ? "typescript" : "rust";
}

export function createLspClientManager(opts: LspClientManagerOptions): LspClientManager {
  const ttl = opts.idleTtlMs ?? DEFAULT_IDLE_TTL;
  const sweep = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL;
  const handles = new Map<string, LspServerHandle>();
  const pending = new Map<string, Promise<LspResult<LspServerHandle>>>();
  let disposed = false;
  let sweeping = false;

  const sweeper = setInterval(async () => {
    if (disposed || sweeping) return;
    sweeping = true;
    try {
      const now = Date.now();
      const snapshot = [...handles.entries()];
      for (const [key, handle] of snapshot) {
        if (now - handle.lastUsedAt > ttl && handles.get(key) === handle) {
          handles.delete(key);
          await handle.dispose().catch(() => {});
        }
      }
    } finally {
      sweeping = false;
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
    const inflight = pending.get(key);
    if (inflight) return inflight;

    const p = (async (): Promise<LspResult<LspServerHandle>> => {
      try {
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
        try {
          await handle.ready();
        } catch (err) {
          await handle.dispose().catch(() => {});
          return {
            kind: "error",
            error: { code: "lsp.indexing", message: (err as Error).message },
          };
        }
        handles.set(key, handle);
        return { kind: "ok", value: handle };
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, p);
    return p;
  }

  function preflight(root: string, filePath: string): LspResult<{ language: LspLanguage }> {
    if (!isPathInside(root, filePath)) {
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
    method: string,
    params: (uri: string) => unknown,
    convert: (raw: unknown) => T,
  ): Promise<LspResult<T>> {
    const pre = preflight(root, filePath);
    if (pre.kind === "error") return pre;
    const handle = await getHandle(root, pre.value.language);
    if (handle.kind === "error") return handle;
    const uri = pathToFileUri(filePath);
    let raw: unknown;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      await handle.value.ensureOpen(filePath, langIdFor(pre.value.language));
      raw = await Promise.race([
        handle.value.send(method, params(uri)),
        new Promise<never>((_, reject) => {
          timerId = setTimeout(() => reject(new Error("timeout")), DISPATCH_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      return {
        kind: "error",
        error: { code: "lsp.indexing", message: (err as Error).message },
      };
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
    }
    return { kind: "ok", value: convert(raw) };
  }

  return {
    diagnostics: (root, filePath) =>
      dispatch(
        root,
        filePath,
        "textDocument/diagnostic",
        (uri) => ({ textDocument: { uri } }),
        (raw) => ((raw as { items?: Diagnostic[] })?.items ?? []) as Diagnostic[],
      ),
    definition: (root, filePath, line, character) =>
      dispatch(
        root,
        filePath,
        "textDocument/definition",
        (uri) => ({ textDocument: { uri }, position: { line, character } }),
        (raw) => normalizeLocations(raw),
      ),
    references: (root, filePath, line, character, includeDecl) =>
      dispatch(
        root,
        filePath,
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
        "textDocument/hover",
        (uri) => ({ textDocument: { uri }, position: { line, character } }),
        (raw) => normalizeHover(raw),
      ),
    cacheSize: () => handles.size,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
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
