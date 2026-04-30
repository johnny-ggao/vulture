import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { readJsonFile, writeJsonFile } from "./jsonFileStore";

export type SkillCatalogSource = "local" | "remote" | "manual";

export interface SkillCatalogEntry {
  name: string;
  description: string;
  version: string;
  source: SkillCatalogSource;
  packagePath?: string;
  homepage?: string;
  installed: boolean;
  installedVersion: string | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface ImportSkillCatalogInput {
  packagePath: string;
  source?: SkillCatalogSource;
  homepage?: string;
}

export interface SaveSkillCatalogInput {
  name: string;
  description: string;
  version?: string;
  source?: SkillCatalogSource;
  packagePath?: string;
  homepage?: string;
}

interface StoredSkillCatalogEntry {
  name: string;
  description: string;
  version: string;
  source: SkillCatalogSource;
  packagePath?: string;
  homepage?: string;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

interface SkillManifest {
  name: string;
  description: string;
  version: string;
}

interface SkillCatalogFile {
  schemaVersion: 1;
  items: StoredSkillCatalogEntry[];
}

const EMPTY_CATALOG: SkillCatalogFile = { schemaVersion: 1, items: [] };

export class SkillCatalogStore {
  private readonly catalogPath: string;
  private readonly profileSkillsDir: string;

  constructor(private readonly profileDir: string) {
    this.catalogPath = join(profileDir, "skill-catalog", "catalog.json");
    this.profileSkillsDir = join(profileDir, "skills");
  }

  list(): SkillCatalogEntry[] {
    const installed = this.installedVersions();
    return this.readCatalog()
      .items.slice()
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
      .map((entry) => ({
        ...entry,
        installed: installed.has(entry.name),
        installedVersion: installed.get(entry.name) ?? null,
      }));
  }

  get(name: string): SkillCatalogEntry | null {
    return this.list().find((entry) => entry.name === name) ?? null;
  }

  upsert(input: SaveSkillCatalogInput): SkillCatalogEntry {
    const value = normalizeSaveInput(input);
    const catalog = this.readCatalog();
    const now = nowIso8601();
    const existingIndex = catalog.items.findIndex((entry) => entry.name === value.name);
    const existing = existingIndex >= 0 ? catalog.items[existingIndex] : null;
    const next: StoredSkillCatalogEntry = {
      ...existing,
      ...value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existingIndex >= 0) catalog.items[existingIndex] = next;
    else catalog.items.push(next);
    this.writeCatalog(catalog);
    return this.get(value.name)!;
  }

  importPackage(input: ImportSkillCatalogInput): SkillCatalogEntry {
    const packageDir = normalizeAbsoluteDirectory(input.packagePath, "packagePath");
    const manifest = readSkillManifest(packageDir);
    return this.upsert({
      ...manifest,
      source: input.source ?? "local",
      packagePath: packageDir,
      homepage: input.homepage,
    });
  }

  install(name: string): SkillCatalogEntry {
    const entry = this.readCatalog().items.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`skill catalog entry not found: ${name}`);
    const dest = join(this.profileSkillsDir, entry.name);
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });

    if (entry.packagePath) {
      const packageDir = normalizeAbsoluteDirectory(entry.packagePath, "packagePath");
      cpSync(packageDir, dest, { recursive: true });
    } else {
      mkdirSync(dest, { recursive: true });
      writeFileSync(
        join(dest, "SKILL.md"),
        [
          "---",
          `name: ${entry.name}`,
          `description: ${entry.description}`,
          `version: ${entry.version}`,
          "---",
          "",
          entry.description,
          "",
        ].join("\n"),
      );
    }

    return this.get(entry.name)!;
  }

  updateAll(): SkillCatalogEntry[] {
    for (const entry of this.readCatalog().items) {
      if (entry.packagePath) this.install(entry.name);
    }
    return this.list();
  }

  private readCatalog(): SkillCatalogFile {
    const parsed = readJsonFile<SkillCatalogFile>(this.catalogPath, EMPTY_CATALOG);
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.items)) return EMPTY_CATALOG;
    return {
      schemaVersion: 1,
      items: parsed.items.filter(isStoredEntry),
    };
  }

  private writeCatalog(value: SkillCatalogFile): void {
    writeJsonFile(this.catalogPath, {
      schemaVersion: 1,
      items: value.items.slice().sort((left, right) => left.name.localeCompare(right.name, "en")),
    });
  }

  private installedVersions(): Map<string, string> {
    const result = new Map<string, string>();
    if (!existsSync(this.profileSkillsDir)) return result;
    let names: string[] = [];
    try {
      names = readdirNames(this.profileSkillsDir);
    } catch {
      return result;
    }
    for (const name of names) {
      const skillDir = join(this.profileSkillsDir, name);
      const skillFile = join(skillDir, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      try {
        const manifest = readSkillManifest(skillDir);
        result.set(manifest.name, manifest.version);
      } catch {
        result.set(name, "0.0.0");
      }
    }
    return result;
  }
}

function normalizeSaveInput(input: SaveSkillCatalogInput): Omit<StoredSkillCatalogEntry, "createdAt" | "updatedAt"> {
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  const description = input.description.trim();
  if (!description) throw new Error("description is required");
  const version = (input.version ?? "0.0.0").trim();
  if (!version) throw new Error("version is required");
  if (input.packagePath !== undefined) normalizeAbsoluteDirectory(input.packagePath, "packagePath");
  return {
    name,
    description,
    version,
    source: input.source ?? "manual",
    packagePath: input.packagePath ? resolve(input.packagePath) : undefined,
    homepage: input.homepage?.trim() || undefined,
  };
}

function readSkillManifest(skillDir: string): SkillManifest {
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) throw new Error(`SKILL.md not found in ${skillDir}`);
  const raw = readFileSync(skillFile, "utf8");
  const frontmatter = parseFrontmatter(raw);
  const name = frontmatter.name?.trim() || basename(skillDir);
  const description = frontmatter.description?.trim();
  if (!description) throw new Error("skill description is required");
  return {
    name,
    description,
    version: frontmatter.version?.trim() || "0.0.0",
  };
}

function parseFrontmatter(raw: string): Record<string, string> {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return {};
  const parsed: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) parsed[key] = stripQuotes(value);
  }
  return parsed;
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

function normalizeAbsoluteDirectory(path: string, field: string): string {
  if (!isAbsolute(path)) throw new Error(`${field} must be absolute`);
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${field} must be an existing directory`);
  }
  return resolved;
}

function isStoredEntry(value: unknown): value is StoredSkillCatalogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StoredSkillCatalogEntry>;
  return (
    typeof entry.name === "string" &&
    typeof entry.description === "string" &&
    typeof entry.version === "string" &&
    isSource(entry.source) &&
    typeof entry.createdAt === "string" &&
    typeof entry.updatedAt === "string" &&
    (entry.packagePath === undefined || typeof entry.packagePath === "string") &&
    (entry.homepage === undefined || typeof entry.homepage === "string")
  );
}

function isSource(value: unknown): value is SkillCatalogSource {
  return value === "local" || value === "remote" || value === "manual";
}

function readdirNames(path: string): string[] {
  return Array.from(new Bun.Glob("*").scanSync({ cwd: path, onlyFiles: false }));
}
