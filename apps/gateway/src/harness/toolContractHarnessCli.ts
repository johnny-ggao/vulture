import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { GatewayToolCategory } from "../tools/types";
import {
  defaultToolContractFixtures,
  filterToolContractFixtures,
  runToolContractHarness,
  summarizeToolContractResults,
} from "./toolContractHarness";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixtures = filterToolContractFixtures(defaultToolContractFixtures, {
    tools: args.tools,
    categories: args.categories,
  });
  if (args.list) {
    for (const fixture of fixtures) {
      console.log(`${fixture.toolId}\t${fixture.expectedCategory}\t${fixture.expectedRisk}`);
    }
    return;
  }

  const repoRoot = findRepoRoot(process.cwd());
  const artifactDir = resolve(
    args.artifactDir ??
      process.env.VULTURE_TOOL_CONTRACT_ARTIFACT_DIR ??
      join(repoRoot, ".artifacts", "tool-contract-harness"),
  );
  const workspacePath = resolve(
    process.env.VULTURE_TOOL_CONTRACT_WORKSPACE_DIR ?? repoRoot,
  );
  const results = await runToolContractHarness({ artifactDir, fixtures, workspacePath });
  const summary = summarizeToolContractResults(results);

  for (const result of results) {
    const marker = result.status === "passed" ? "PASS" : "FAIL";
    console.log(`${marker} ${result.toolId}`);
    for (const check of result.checks.filter((item) => item.status === "failed")) {
      console.log(`  ${check.name}: ${check.error}`);
    }
  }
  console.log(`Tool contract harness: ${summary.passed}/${summary.total} passed`);
  process.exitCode = summary.status === "passed" ? 0 : 1;
}

export function parseArgs(args: readonly string[]): {
  list: boolean;
  tools: string[];
  categories: GatewayToolCategory[];
  artifactDir?: string;
} {
  const tools = parseList(process.env.VULTURE_TOOL_CONTRACT_TOOLS ?? "");
  const categories = parseList(
    process.env.VULTURE_TOOL_CONTRACT_CATEGORIES ?? "",
  ) as GatewayToolCategory[];
  let artifactDir: string | undefined;
  let list = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg === "--tool") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--tool requires an id");
      tools.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--tool=")) {
      tools.push(arg.slice("--tool=".length));
      continue;
    }
    if (arg === "--category") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--category requires a value");
      categories.push(...(parseList(value) as GatewayToolCategory[]));
      index += 1;
      continue;
    }
    if (arg.startsWith("--category=")) {
      categories.push(...(parseList(arg.slice("--category=".length)) as GatewayToolCategory[]));
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

  return { list, tools, categories, artifactDir };
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
