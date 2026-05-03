import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { platform } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source?: "builtin" | "profile" | "workspace" | "agent-core";
  modelInvocationEnabled: boolean;
  userInvocable?: boolean;
  metadata?: SkillMetadata;
}

export interface LoadSkillEntriesOptions {
  workspaceDir: string;
  profileDir?: string;
  agentCoreDir?: string;
  builtinDir?: string;
  maxSkillFileBytes?: number;
}

export interface SkillMetadata {
  always?: boolean;
  os?: string[];
  requires?: {
    env?: string[];
  };
}

const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;

export function loadSkillEntries(opts: LoadSkillEntriesOptions): SkillEntry[] {
  const maxSkillFileBytes = opts.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES;
  const builtinSkills = opts.builtinDir
    ? loadFlatSkillsFromDir(opts.builtinDir, maxSkillFileBytes, "builtin")
    : [];
  const profileSkills = opts.profileDir
    ? loadSkillsFromRoot(join(opts.profileDir, "skills"), maxSkillFileBytes, "profile")
    : [];
  const workspaceSkills = loadSkillsFromRoot(
    join(opts.workspaceDir, "skills"),
    maxSkillFileBytes,
    "workspace",
  );
  const agentCoreSkills = opts.agentCoreDir
    ? loadSkillsFromRoot(join(opts.agentCoreDir, "skills"), maxSkillFileBytes, "agent-core")
    : [];
  const merged = new Map<string, SkillEntry>();

  for (const skill of builtinSkills) merged.set(skill.name, skill);
  for (const skill of profileSkills) merged.set(skill.name, skill);
  for (const skill of workspaceSkills) merged.set(skill.name, skill);
  for (const skill of agentCoreSkills) merged.set(skill.name, skill);

  return Array.from(merged.values())
    .filter(isEligible)
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
}

export function filterSkillEntries(
  entries: readonly SkillEntry[],
  allowlist: readonly string[] | undefined,
): SkillEntry[] {
  if (allowlist === undefined) return [...entries];
  const allowed = new Set(allowlist);
  if (allowed.size === 0) return [];
  return entries.filter((entry) => allowed.has(entry.name));
}

export function formatSkillsForPrompt(entries: readonly SkillEntry[]): string {
  const visible = entries
    .filter((entry) => entry.modelInvocationEnabled)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (visible.length === 0) return "";

  const lines = [
    "",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
  ];
  for (const entry of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(entry.name)}</name>`);
    lines.push(`    <description>${escapeXml(entry.description)}</description>`);
    lines.push(`    <location>${escapeXml(entry.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function loadFlatSkillsFromDir(
  dir: string,
  maxSkillFileBytes: number,
  source: "builtin" | "profile" | "workspace" | "agent-core",
): SkillEntry[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  const rootRealPath = safeRealpath(root);
  if (!rootRealPath) return [];

  let files: string[];
  try {
    files = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
      .map((entry) => join(root, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }

  return files
    .map((filePath) => loadSkillFromFlatFile(filePath, rootRealPath, maxSkillFileBytes, source))
    .filter((entry): entry is SkillEntry => entry !== null);
}

function loadSkillFromFlatFile(
  filePath: string,
  rootRealPath: string,
  maxSkillFileBytes: number,
  source: "builtin" | "profile" | "workspace" | "agent-core",
): SkillEntry | null {
  if (isSymlink(filePath)) return null;
  const fileRealPath = safeRealpath(filePath);
  if (!fileRealPath || !isPathInside(rootRealPath, fileRealPath)) return null;

  try {
    if (statSync(fileRealPath).size > maxSkillFileBytes) return null;
  } catch {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(fileRealPath, "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(raw);
  const name = normalizeFrontmatterString(frontmatter.name) ?? basename(filePath, ".md");
  const description = normalizeFrontmatterString(frontmatter.description);
  if (!name || !description) return null;

  return {
    name,
    description,
    filePath: fileRealPath,
    baseDir: rootRealPath,
    source,
    modelInvocationEnabled: parseBoolean(frontmatter["disable-model-invocation"]) !== true,
    userInvocable: parseBoolean(frontmatter["user-invocable"]) ?? true,
    metadata: parseSkillMetadata(frontmatter["metadata.openclaw"]),
  };
}

function loadSkillsFromRoot(
  rootDir: string,
  maxSkillFileBytes: number,
  source: "builtin" | "profile" | "workspace" | "agent-core",
): SkillEntry[] {
  const root = resolve(rootDir);
  if (!existsSync(root)) return [];
  const rootRealPath = safeRealpath(root);
  if (!rootRealPath) return [];

  const rootSkill = loadSkillFromDirectory(root, rootRealPath, maxSkillFileBytes, source);
  if (rootSkill) return [rootSkill];

  const subdirSkills = listCandidateSkillDirs(root)
    .map((candidate) => loadSkillFromDirectory(candidate, rootRealPath, maxSkillFileBytes, source))
    .filter((entry): entry is SkillEntry => entry !== null);

  const flatFileSkills = loadFlatSkillsFromDir(root, maxSkillFileBytes, source);

  // Within a single source, subdirectory-format skills (skill-name/SKILL.md) win
  // over flat .md files (skill-name.md) of the same name — the directory format
  // is more expressive (can carry sibling assets), so it wins ties.
  const merged = new Map<string, SkillEntry>();
  for (const skill of flatFileSkills) merged.set(skill.name, skill);
  for (const skill of subdirSkills) merged.set(skill.name, skill);
  return Array.from(merged.values());
}

function listCandidateSkillDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => join(root, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function loadSkillFromDirectory(
  skillDir: string,
  rootRealPath: string,
  maxSkillFileBytes: number,
  source: "builtin" | "profile" | "workspace" | "agent-core",
): SkillEntry | null {
  const skillDirRealPath = safeRealpath(skillDir);
  if (!skillDirRealPath || !isPathInside(rootRealPath, skillDirRealPath)) return null;

  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) return null;
  if (isSymlink(skillFile)) return null;
  const skillFileRealPath = safeRealpath(skillFile);
  if (!skillFileRealPath || !isPathInside(rootRealPath, skillFileRealPath)) return null;

  try {
    if (statSync(skillFileRealPath).size > maxSkillFileBytes) return null;
  } catch {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(skillFileRealPath, "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(raw);
  const name = normalizeFrontmatterString(frontmatter.name) ?? basename(skillDir);
  const description = normalizeFrontmatterString(frontmatter.description);
  if (!name || !description) return null;

  return {
    name,
    description,
    filePath: skillFileRealPath,
    baseDir: skillDirRealPath,
    source,
    modelInvocationEnabled: parseBoolean(frontmatter["disable-model-invocation"]) !== true,
    userInvocable: parseBoolean(frontmatter["user-invocable"]) ?? true,
    metadata: parseSkillMetadata(frontmatter["metadata.openclaw"]),
  };
}

function parseFrontmatter(raw: string): Record<string, string> {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return {};
  const block = normalized.slice(4, end);
  const parsed: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key) parsed[key] = stripQuotes(value);
  }
  return parsed;
}

function parseSkillMetadata(raw: string | undefined): SkillMetadata | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as SkillMetadata;
    if (!parsed || typeof parsed !== "object") return undefined;
    return {
      always: parsed.always === true,
      os: Array.isArray(parsed.os)
        ? parsed.os.filter((value): value is string => typeof value === "string")
        : undefined,
      requires:
        parsed.requires && typeof parsed.requires === "object"
          ? {
              env: Array.isArray(parsed.requires.env)
                ? parsed.requires.env.filter((value): value is string => typeof value === "string")
                : undefined,
            }
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function isEligible(entry: SkillEntry): boolean {
  const metadata = entry.metadata;
  if (!metadata || metadata.always === true) return true;
  if (metadata.os && metadata.os.length > 0 && !metadata.os.includes(platform())) return false;
  const requiredEnv = metadata.requires?.env ?? [];
  return requiredEnv.every((name) => Boolean(process.env[name]));
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function normalizeFrontmatterString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
