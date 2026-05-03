import { glob as tinyGlob } from "tinyglobby";

export interface GlobOptions {
  pattern: string;
  path?: string;
  maxResults?: number;
}

export interface GlobResult {
  paths: string[];
  truncated: boolean;
}

const DEFAULT_MAX = 500;
const SKIP_DIRS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/target/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.cache/**",
];

export async function runGlob(opts: GlobOptions): Promise<GlobResult> {
  const max = opts.maxResults ?? DEFAULT_MAX;
  const cwd = opts.path ?? process.cwd();
  const all = await tinyGlob(opts.pattern, {
    cwd,
    absolute: true,
    ignore: SKIP_DIRS,
    dot: false,
    followSymbolicLinks: false,
  });
  if (all.length <= max) {
    return { paths: all, truncated: false };
  }
  return { paths: all.slice(0, max), truncated: true };
}
