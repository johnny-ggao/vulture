import { desktopScenarios, type DesktopScenario } from "./scenarios";

export interface DesktopE2EArgs {
  list: boolean;
  scenarios: string[];
  tags: string[];
}

export interface DesktopE2EIO {
  env?: Record<string, string | undefined>;
  write?: (message: string) => void;
  writeError?: (message: string) => void;
}

export function parseDesktopE2EArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): DesktopE2EArgs {
  const parsed: DesktopE2EArgs = {
    list: false,
    scenarios: splitList(env.VULTURE_DESKTOP_E2E_SCENARIOS ?? ""),
    tags: splitList(env.VULTURE_DESKTOP_E2E_TAGS ?? ""),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--list") {
      parsed.list = true;
      continue;
    }

    if (arg === "--scenario") {
      const value = argv[index + 1];
      if (!isSeparatedValue(value)) {
        throw new Error("--scenario requires an id");
      }
      parsed.scenarios.push(value.trim());
      index += 1;
      continue;
    }

    if (arg === "--tag") {
      const value = argv[index + 1];
      if (!isSeparatedValue(value)) {
        throw new Error("--tag requires a value");
      }
      parsed.tags.push(...parseTagValue(value));
      index += 1;
      continue;
    }

    if (arg.startsWith("--scenario=")) {
      const value = arg.slice("--scenario=".length).trim();
      if (!value) {
        throw new Error("--scenario requires an id");
      }
      parsed.scenarios.push(value);
      continue;
    }

    if (arg.startsWith("--tag=")) {
      parsed.tags.push(...parseTagValue(arg.slice("--tag=".length)));
      continue;
    }

    throw new Error(`Unknown argument ${arg}`);
  }

  return parsed;
}

export function selectDesktopScenarios(
  input: Pick<DesktopE2EArgs, "scenarios" | "tags">,
  scenarios: readonly DesktopScenario[] = desktopScenarios,
): DesktopScenario[] {
  if (input.scenarios.length > 0) {
    const seen = new Set<string>();
    const selected: DesktopScenario[] = [];

    for (const id of input.scenarios) {
      const scenario = scenarios.find((candidate) => candidate.id === id);
      if (!scenario) {
        throw new Error(`Unknown desktop E2E scenario ${id}`);
      }
      if (!seen.has(id)) {
        seen.add(id);
        selected.push(scenario);
      }
    }

    return selected;
  }

  if (input.tags.length === 0) {
    return [...scenarios];
  }

  const tags = new Set(input.tags);
  const selected = scenarios.filter((scenario) => scenario.tags.some((tag) => tags.has(tag)));
  if (selected.length === 0) {
    throw new Error(`No desktop E2E scenarios match tags: ${input.tags.join(", ")}`);
  }
  return selected;
}

export function main(argv = process.argv.slice(2), io: DesktopE2EIO = {}): number {
  const write = io.write ?? console.log;
  const writeError = io.writeError ?? console.error;

  try {
    const args = parseDesktopE2EArgs(argv, io.env);
    const selected = selectDesktopScenarios(args);

    if (args.list) {
      for (const scenario of selected) {
        write(`${scenario.id}\t${scenario.name}\t${scenario.tags.join(",")}`);
      }
      return 0;
    }

    writeError("Desktop E2E real driver is intentionally disabled until Task 6/7 wiring lands.");
    return 1;
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTagValue(value: string): string[] {
  const tags = splitList(value);
  if (tags.length === 0) {
    throw new Error("--tag requires a value");
  }
  return tags;
}

function isSeparatedValue(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.startsWith("--");
}

if (import.meta.main) {
  process.exitCode = main();
}
