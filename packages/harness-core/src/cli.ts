import { join, resolve } from "node:path";
import { findHarnessRepoRoot } from "./paths";
import {
  nonEmpty,
  separatedValue,
  splitList,
  type HarnessScenarioLike,
  type HarnessStatus,
} from "./shared";

export interface HarnessCliArgs {
  list: boolean;
  ids: string[];
  tags: string[];
  artifactDir?: string;
}

export interface HarnessCliParseOptions {
  idFlag?: string;
  tagFlag?: string;
  idEnv?: string;
  tagEnv?: string;
  artifactDirFlag?: string;
  artifactDirEnv?: string;
}

const DEFAULT_PARSE_OPTIONS: Required<Pick<
  HarnessCliParseOptions,
  "idFlag" | "tagFlag" | "artifactDirFlag"
>> = {
  idFlag: "scenario",
  tagFlag: "tag",
  artifactDirFlag: "artifact-dir",
};

export function parseHarnessCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  options: HarnessCliParseOptions = {},
): HarnessCliArgs {
  const idFlag = options.idFlag ?? DEFAULT_PARSE_OPTIONS.idFlag;
  const tagFlag = options.tagFlag ?? DEFAULT_PARSE_OPTIONS.tagFlag;
  const artifactDirFlag = options.artifactDirFlag ?? DEFAULT_PARSE_OPTIONS.artifactDirFlag;
  const parsed: HarnessCliArgs = {
    list: false,
    ids: splitList(options.idEnv ? env[options.idEnv] ?? "" : ""),
    tags: splitList(options.tagEnv ? env[options.tagEnv] ?? "" : ""),
    artifactDir: options.artifactDirEnv ? nonEmpty(env[options.artifactDirEnv]) : undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--list") {
      parsed.list = true;
      continue;
    }

    if (arg === `--${idFlag}`) {
      const value = separatedValue(argv[index + 1], `--${idFlag} requires an id`);
      parsed.ids.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith(`--${idFlag}=`)) {
      const value = arg.slice(idFlag.length + 3).trim();
      if (!value) throw new Error(`--${idFlag} requires an id`);
      parsed.ids.push(value);
      continue;
    }

    if (arg === `--${tagFlag}`) {
      const value = separatedValue(argv[index + 1], `--${tagFlag} requires a value`);
      const tags = splitList(value);
      if (tags.length === 0) throw new Error(`--${tagFlag} requires a value`);
      parsed.tags.push(...tags);
      index += 1;
      continue;
    }
    if (arg.startsWith(`--${tagFlag}=`)) {
      const tags = splitList(arg.slice(tagFlag.length + 3));
      if (tags.length === 0) throw new Error(`--${tagFlag} requires a value`);
      parsed.tags.push(...tags);
      continue;
    }

    if (arg === `--${artifactDirFlag}`) {
      parsed.artifactDir = separatedValue(
        argv[index + 1],
        `--${artifactDirFlag} requires a path`,
      );
      index += 1;
      continue;
    }
    if (arg.startsWith(`--${artifactDirFlag}=`)) {
      const value = arg.slice(artifactDirFlag.length + 3).trim();
      if (!value) throw new Error(`--${artifactDirFlag} requires a path`);
      parsed.artifactDir = value;
      continue;
    }

    throw new Error(`Unknown argument ${arg}`);
  }

  return parsed;
}

export function selectHarnessScenarios<T extends HarnessScenarioLike>(
  scenarios: readonly T[],
  filters: { ids?: readonly string[]; tags?: readonly string[] },
  options: { label?: string; unknownMessage?: (id: string) => string; noTagMatchMessage?: (tags: readonly string[]) => string } = {},
): T[] {
  const ids = filters.ids ?? [];
  if (ids.length > 0) {
    const seen = new Set<string>();
    const selected: T[] = [];
    for (const id of ids) {
      const found = scenarios.find((scenario) => scenario.id === id);
      if (!found) {
        throw new Error(options.unknownMessage?.(id) ?? `Unknown ${options.label ?? "scenario"}: ${id}`);
      }
      if (!seen.has(id)) {
        seen.add(id);
        selected.push(found);
      }
    }
    return selected;
  }

  const tags = filters.tags ?? [];
  if (tags.length === 0) return [...scenarios];
  const wanted = new Set(tags);
  const selected = scenarios.filter((scenario) => scenario.tags?.some((tag) => wanted.has(tag)));
  if (selected.length === 0 && tags.length > 0) {
    throw new Error(
      options.noTagMatchMessage?.(tags) ??
        `No ${options.label ?? "scenarios"} match tags: ${tags.join(", ")}`,
    );
  }
  return selected;
}

export function formatHarnessListLine(scenario: HarnessScenarioLike): string {
  return `${scenario.id}\t${scenario.name}\t${(scenario.tags ?? []).join(",")}`;
}

export interface HarnessLaneCliRunInput<TScenario> {
  scenarios: readonly TScenario[];
  artifactDir: string;
  workspacePath: string;
}

export interface HarnessLaneCliResultRow {
  id: string;
  status: HarnessStatus;
  details?: readonly string[];
}

export interface HarnessLaneCliRunOutput {
  status: HarnessStatus;
  total: number;
  passed: number;
  rows: readonly HarnessLaneCliResultRow[];
}

export interface HarnessLaneCliConfig<TScenario> {
  parseOptions: HarnessCliParseOptions;
  scenarios: readonly TScenario[];
  filter: (
    scenarios: readonly TScenario[],
    filters: { ids: readonly string[]; tags: readonly string[] },
  ) => readonly TScenario[];
  formatListLine: (scenario: TScenario) => string;
  artifactDirEnv: string;
  artifactDirSubdir: string;
  workspaceDirEnv: string;
  laneTitle: string;
  run: (input: HarnessLaneCliRunInput<TScenario>) => Promise<HarnessLaneCliRunOutput>;
}

export async function runHarnessLaneCli<TScenario>(
  config: HarnessLaneCliConfig<TScenario>,
): Promise<void> {
  const args = parseHarnessCliArgs(process.argv.slice(2), process.env, config.parseOptions);
  const filtered = config.filter(config.scenarios, { ids: args.ids, tags: args.tags });
  if (args.list) {
    for (const scenario of filtered) console.log(config.formatListLine(scenario));
    return;
  }
  const repoRoot = findHarnessRepoRoot(process.cwd());
  const artifactDir = resolve(
    args.artifactDir ??
      process.env[config.artifactDirEnv] ??
      join(repoRoot, ".artifacts", config.artifactDirSubdir),
  );
  const workspacePath = resolve(process.env[config.workspaceDirEnv] ?? repoRoot);
  const result = await config.run({ scenarios: filtered, artifactDir, workspacePath });
  for (const row of result.rows) {
    const marker = row.status === "passed" ? "PASS" : "FAIL";
    console.log(`${marker} ${row.id}`);
    for (const detail of row.details ?? []) console.log(`  ${detail}`);
  }
  console.log(`${config.laneTitle}: ${result.passed}/${result.total} passed`);
  process.exitCode = result.status === "passed" ? 0 : 1;
}
