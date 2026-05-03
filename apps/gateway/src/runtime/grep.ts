import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { glob as tinyGlob } from "tinyglobby";

export interface GrepOptions {
  pattern: string;
  path?: string;
  glob?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  maxMatches?: number;
  useRipgrep?: boolean; // injection point for tests; runtime auto-detects
}

export interface GrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

const DEFAULT_MAX_MATCHES = 200;
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", ".next", ".cache"]);

let ripgrepPromise: Promise<boolean> | null = null;

export function detectRipgrep(): Promise<boolean> {
  if (!ripgrepPromise) {
    ripgrepPromise = new Promise<boolean>((resolve) => {
      let resolved = false;
      const settle = (val: boolean) => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };
      const proc = spawn("rg", ["--version"], { stdio: "ignore" });
      proc.on("error", () => settle(false));
      proc.on("exit", (code) => settle(code === 0));
    });
  }
  return ripgrepPromise;
}

type RipgrepEvent =
  | { type: "begin"; data: { path: { text: string } } }
  | { type: "end"; data: { path: { text: string } } }
  | { type: "summary"; data: unknown }
  | {
      type: "match";
      data: {
        path: { text: string };
        line_number: number;
        lines: { text: string };
        submatches: { start: number; end: number }[];
      };
    };

async function runGrepWithRipgrep(opts: GrepOptions, max: number): Promise<GrepResult> {
  const args = ["--json", "-n", "--column"];
  if (!(opts.caseSensitive ?? false)) args.push("-i");
  if (!(opts.regex ?? false)) args.push("-F");
  if (opts.glob) args.push("--glob", opts.glob);
  args.push(opts.pattern, opts.path ?? ".");

  return new Promise<GrepResult>((resolve, reject) => {
    const matches: GrepMatch[] = [];
    let truncated = false;
    let settled = false;
    let killing = false;
    const done = (result?: GrepResult, err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result!);
    };
    const proc = spawn("rg", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdoutBuf = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      if (killing) return;
      stdoutBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as RipgrepEvent;
          if (obj.type !== "match") continue;
          for (const sub of obj.data.submatches) {
            if (matches.length >= max) {
              truncated = true;
              killing = true;
              proc.kill();
              return;
            }
            matches.push({
              file: obj.data.path.text,
              line: obj.data.line_number,
              column: sub.start + 1,
              text: obj.data.lines.text.replace(/\n$/, ""),
            });
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    proc.on("error", (err) => done(undefined, err));
    proc.on("exit", () => done({ matches, truncated }));
  });
}

export async function runGrep(opts: GrepOptions): Promise<GrepResult> {
  const max = opts.maxMatches ?? DEFAULT_MAX_MATCHES;
  const useRipgrep = opts.useRipgrep ?? (await detectRipgrep());
  if (useRipgrep) {
    return runGrepWithRipgrep(opts, max);
  }
  return runGrepJS(opts, max);
}

async function runGrepJS(opts: GrepOptions, max: number): Promise<GrepResult> {
  const root = opts.path ?? process.cwd();
  const matcher = compileMatcher(opts.pattern, opts.regex ?? false, opts.caseSensitive ?? false);

  const files = opts.glob
    ? ((await tinyGlob(opts.glob, {
        cwd: root,
        absolute: true,
        dot: false,
        followSymbolicLinks: false,
      })) as string[])
    : await walk(root);

  const matches: GrepMatch[] = [];
  let truncated = false;

  for (const file of files) {
    if (matches.length >= max) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "EACCES") continue;
      throw err;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= max) {
        truncated = true;
        break;
      }
      const hit = matcher(lines[i] ?? "");
      if (hit !== null) {
        matches.push({ file, line: i + 1, column: hit + 1, text: lines[i] ?? "" });
      }
    }
  }

  return { matches, truncated };
}

function compileMatcher(
  pattern: string,
  regex: boolean,
  caseSensitive: boolean,
): (line: string) => number | null {
  if (regex) {
    const re = new RegExp(pattern, caseSensitive ? "" : "i");
    return (line) => {
      const m = re.exec(line);
      return m ? m.index : null;
    };
  }
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return (line) => {
    const hay = caseSensitive ? line : line.toLowerCase();
    const idx = hay.indexOf(needle);
    return idx >= 0 ? idx : null;
  };
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue; // skip hidden
        if (entry.isSymbolicLink()) continue; // avoid symlink cycles
        await visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(join(dir, entry.name));
      }
    }
  }
  await visit(root);
  return out;
}
