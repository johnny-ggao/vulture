import { existsSync, readFileSync } from "node:fs";

export interface HarnessLaneRegistryEntry {
  lane: string;
  artifactDir: string;
  required: boolean;
  command: string;
  description?: string;
}

export const HARNESS_LANE_REGISTRY = [
  {
    lane: "runtime",
    artifactDir: "runtime-harness",
    required: true,
    command: "bun run harness:runtime",
    description: "In-process agent runtime scenarios with scripted LLM/tool behavior.",
  },
  {
    lane: "tool-contract",
    artifactDir: "tool-contract-harness",
    required: true,
    command: "bun run harness:tools",
    description: "Core tool metadata, schema, approval, idempotency, and SDK adapter contracts.",
  },
  {
    lane: "acceptance",
    artifactDir: "acceptance",
    required: true,
    command: "bun run harness:acceptance",
    description: "Gateway product scenarios over HTTP, SSE, recovery, attachments, MCP, and subagents.",
  },
  {
    lane: "desktop-e2e",
    artifactDir: "desktop-e2e",
    required: false,
    command: "bun run harness:desktop-e2e",
    description: "Real Tauri shell smoke scenarios driven through WebDriver.",
  },
  {
    lane: "live",
    artifactDir: "live-harness",
    required: false,
    command: "bun run harness:live",
    description: "Real OpenAI / Codex calls. Opt-in via OPENAI_API_KEY; never auto-runs.",
  },
] as const satisfies readonly HarnessLaneRegistryEntry[];

export type HarnessLane = typeof HARNESS_LANE_REGISTRY[number]["lane"];

export type HarnessStatus = "passed" | "failed";

export function isHarnessLane(value: unknown): value is HarnessLane {
  return typeof value === "string" && HARNESS_LANE_REGISTRY.some((entry) => entry.lane === value);
}

export function getHarnessLaneEntry(lane: HarnessLane): HarnessLaneRegistryEntry {
  const entry = HARNESS_LANE_REGISTRY.find((item) => item.lane === lane);
  if (!entry) throw new Error(`Unknown harness lane: ${lane}`);
  return entry;
}

export interface HarnessScenarioLike {
  id: string;
  name: string;
  description?: string;
  tags?: readonly string[];
}

export interface HarnessStepReport {
  name: string;
  status: HarnessStatus;
  error?: string;
}

export interface HarnessResultReport {
  id: string;
  name: string;
  status: HarnessStatus;
  durationMs?: number;
  artifactPath?: string;
  error?: string;
  steps?: readonly HarnessStepReport[];
}

export interface HarnessSuiteSummary {
  lane: HarnessLane;
  status: HarnessStatus;
  total: number;
  passed: number;
  failed: number;
  results: HarnessResultReport[];
}

export interface HarnessArtifactManifest extends HarnessSuiteSummary {
  schemaVersion: 1;
  generatedAt: string;
}

export interface HarnessArtifactValidationCheck {
  id: string;
  status: HarnessStatus;
  detail: string;
  path?: string;
  expected?: string;
  actual?: string;
  hint?: string;
  command?: string;
}

export interface HarnessArtifactValidationReport {
  schemaVersion: 1;
  generatedAt: string;
  status: HarnessStatus;
  checks: HarnessArtifactValidationCheck[];
}

export const DEFAULT_HARNESS_ARTIFACT_DIRS = [
  "runtime-harness",
  "tool-contract-harness",
  "acceptance",
  "harness-catalog",
  "harness-report",
] as const;

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function separatedValue(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("--")) throw new Error(message);
  return trimmed;
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

export function uniquePreserveOrder<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHarnessStatus(value: unknown): value is HarnessStatus {
  return value === "passed" || value === "failed";
}

export function readJsonIfPresent<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function fencedMarkdown(value: string): string {
  const longestFence = Math.max(3, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return `${fence}\n${value}\n${fence}`;
}

export function validationCheck(
  id: string,
  status: HarnessStatus,
  detail: string,
  path?: string,
  extra: {
    expected?: string;
    actual?: string;
    hint?: string;
    command?: string;
  } = {},
): HarnessArtifactValidationCheck {
  return {
    id,
    status,
    detail,
    ...(path ? { path } : {}),
    ...extra,
  };
}

export function laneHarnessCommand(lane: HarnessLane): string {
  return getHarnessLaneEntry(lane).command;
}
