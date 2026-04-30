import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  defaultRuntimeHarnessScenarios,
  filterRuntimeHarnessScenarios,
  runRuntimeHarness,
  summarizeRuntimeHarnessResults,
} from "./runtimeHarness";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = filterRuntimeHarnessScenarios(defaultRuntimeHarnessScenarios, {
    scenarios: args.scenarios,
    tags: args.tags,
  });
  if (args.list) {
    for (const scenario of scenarios) {
      console.log(`${scenario.id}\t${scenario.name}\t${(scenario.tags ?? []).join(",")}`);
    }
    return;
  }

  const repoRoot = findRepoRoot(process.cwd());
  const artifactDir = resolve(
    args.artifactDir ??
      process.env.VULTURE_RUNTIME_HARNESS_ARTIFACT_DIR ??
      join(repoRoot, ".artifacts", "runtime-harness"),
  );
  const workspacePath = resolve(
    process.env.VULTURE_RUNTIME_HARNESS_WORKSPACE_DIR ?? repoRoot,
  );
  const results = await runRuntimeHarness({ artifactDir, scenarios, workspacePath });
  const summary = summarizeRuntimeHarnessResults(results);

  for (const result of results) {
    const marker = result.status === "passed" ? "PASS" : "FAIL";
    console.log(`${marker} ${result.scenarioId}`);
    if (result.error) console.log(`  ${result.error}`);
  }
  console.log(`Runtime harness: ${summary.passed}/${summary.total} passed`);
  process.exitCode = summary.status === "passed" ? 0 : 1;
}

export function parseArgs(args: readonly string[]): {
  list: boolean;
  scenarios: string[];
  tags: string[];
  artifactDir?: string;
} {
  const scenarios = parseList(process.env.VULTURE_RUNTIME_HARNESS_SCENARIOS ?? "");
  const tags = parseList(process.env.VULTURE_RUNTIME_HARNESS_TAGS ?? "");
  let artifactDir: string | undefined;
  let list = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg === "--scenario") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--scenario requires an id");
      scenarios.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--scenario=")) {
      scenarios.push(arg.slice("--scenario=".length));
      continue;
    }
    if (arg === "--tag") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--tag requires a value");
      tags.push(...parseList(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--tag=")) {
      tags.push(...parseList(arg.slice("--tag=".length)));
      continue;
    }
    if (arg === "--artifact-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--artifact-dir requires a path");
      artifactDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--artifact-dir=")) {
      artifactDir = arg.slice("--artifact-dir=".length);
      continue;
    }
    throw new Error(`Unknown argument ${arg}`);
  }

  return { list, scenarios, tags, artifactDir };
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (parsed.name === "vulture") return current;
      } catch {
        // Keep walking; malformed package files should not hide a parent root.
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

await main();
