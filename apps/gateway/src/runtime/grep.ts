import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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

export async function runGrep(opts: GrepOptions): Promise<GrepResult> {
  const root = opts.path ?? process.cwd();
  const max = opts.maxMatches ?? DEFAULT_MAX_MATCHES;
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
