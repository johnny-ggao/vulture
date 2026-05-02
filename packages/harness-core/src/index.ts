import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type HarnessLane =
  | "runtime"
  | "tool-contract"
  | "acceptance"
  | "desktop-e2e"
  | (string & {});

export type HarnessStatus = "passed" | "failed";

export interface HarnessScenarioLike {
  id: string;
  name: string;
  description?: string;
  tags?: readonly string[];
}

export interface HarnessCatalogLane {
  lane: HarnessLane;
  description?: string;
  scenarios: readonly HarnessScenarioLike[];
}

export interface HarnessCatalogEntry {
  lane: HarnessLane;
  id: string;
  name: string;
  description: string | null;
  tags: string[];
}

export interface HarnessCatalog {
  schemaVersion: 1;
  generatedAt: string;
  lanes: Array<{
    lane: HarnessLane;
    description: string | null;
    scenarioCount: number;
    tags: string[];
  }>;
  tags: Array<{
    tag: string;
    scenarioCount: number;
    lanes: HarnessLane[];
  }>;
  scenarios: HarnessCatalogEntry[];
}

export interface HarnessDoctorRule {
  id: string;
  name: string;
  severity?: "error" | "warning";
  lane?: HarnessLane;
  tag?: string;
  minScenarios?: number;
}

export interface HarnessDoctorCheck {
  id: string;
  name: string;
  status: "passed" | "warning" | "failed";
  detail: string;
}

export interface HarnessDoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  status: "passed" | "warning" | "failed";
  summary: {
    laneCount: number;
    scenarioCount: number;
    tagCount: number;
  };
  checks: HarnessDoctorCheck[];
}

const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

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

export interface HarnessReportLane {
  lane: HarnessLane;
  status: HarnessStatus | "missing";
  total: number;
  passed: number;
  failed: number;
  artifactPath?: string;
  generatedAt?: string;
}

export interface HarnessReport {
  schemaVersion: 1;
  generatedAt: string;
  status: "passed" | "warning" | "failed";
  lanes: HarnessReportLane[];
  missingRequiredLanes: HarnessLane[];
  missingOptionalLanes: HarnessLane[];
  doctor?: {
    status: HarnessDoctorReport["status"];
    checks: number;
    passed: number;
    warnings: number;
    failed: number;
  };
}

export interface HarnessArtifactValidationCheck {
  id: string;
  status: HarnessStatus;
  detail: string;
  path?: string;
  expected?: string;
  actual?: string;
  hint?: string;
}

export interface HarnessArtifactValidationReport {
  schemaVersion: 1;
  generatedAt: string;
  status: HarnessStatus;
  checks: HarnessArtifactValidationCheck[];
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

export function buildHarnessCatalog(
  lanes: readonly HarnessCatalogLane[],
  generatedAt = new Date().toISOString(),
): HarnessCatalog {
  const scenarios: HarnessCatalogEntry[] = [];
  const tagMap = new Map<string, { scenarioCount: number; lanes: Set<HarnessLane> }>();
  for (const lane of lanes) {
    for (const scenario of lane.scenarios) {
      const tags = [...(scenario.tags ?? [])].sort((left, right) => left.localeCompare(right, "en"));
      scenarios.push({
        lane: lane.lane,
        id: scenario.id,
        name: scenario.name,
        description: scenario.description ?? null,
        tags,
      });
      for (const tag of tags) {
        const existing = tagMap.get(tag) ?? { scenarioCount: 0, lanes: new Set<HarnessLane>() };
        existing.scenarioCount += 1;
        existing.lanes.add(lane.lane);
        tagMap.set(tag, existing);
      }
    }
  }

  return {
    schemaVersion: 1,
    generatedAt,
    lanes: lanes.map((lane) => ({
      lane: lane.lane,
      description: lane.description ?? null,
      scenarioCount: lane.scenarios.length,
      tags: uniqueSorted(lane.scenarios.flatMap((scenario) => scenario.tags ?? [])),
    })),
    tags: Array.from(tagMap.entries())
      .map(([tag, value]) => ({
        tag,
        scenarioCount: value.scenarioCount,
        lanes: Array.from(value.lanes).sort((left, right) => left.localeCompare(right, "en")),
      }))
      .sort((left, right) => left.tag.localeCompare(right.tag, "en")),
    scenarios: scenarios.sort((left, right) => {
      const laneOrder = left.lane.localeCompare(right.lane, "en");
      return laneOrder !== 0 ? laneOrder : left.id.localeCompare(right.id, "en");
    }),
  };
}

export function writeHarnessCatalog(
  artifactDir: string,
  lanes: readonly HarnessCatalogLane[],
): { jsonPath: string; markdownPath: string; catalog: HarnessCatalog } {
  mkdirSync(artifactDir, { recursive: true });
  const catalog = buildHarnessCatalog(lanes);
  const jsonPath = join(artifactDir, "catalog.json");
  const markdownPath = join(artifactDir, "catalog.md");
  writeFileSync(jsonPath, `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(markdownPath, renderHarnessCatalogMarkdown(catalog));
  return { jsonPath, markdownPath, catalog };
}

export function inspectHarnessCatalog(
  catalog: HarnessCatalog,
  rules: readonly HarnessDoctorRule[],
  generatedAt = new Date().toISOString(),
): HarnessDoctorReport {
  const checks = rules.map((rule) => inspectCatalogRule(catalog, rule));
  return buildHarnessDoctorReport(catalog, checks, generatedAt);
}

export function buildHarnessDoctorReport(
  catalog: HarnessCatalog,
  checks: readonly HarnessDoctorCheck[],
  generatedAt = new Date().toISOString(),
): HarnessDoctorReport {
  const failed = checks.some((check) => check.status === "failed");
  const warned = checks.some((check) => check.status === "warning");
  return {
    schemaVersion: 1,
    generatedAt,
    status: failed ? "failed" : warned ? "warning" : "passed",
    summary: {
      laneCount: catalog.lanes.length,
      scenarioCount: catalog.scenarios.length,
      tagCount: catalog.tags.length,
    },
    checks: [...checks],
  };
}

export function inspectHarnessCatalogLanes(
  lanes: readonly HarnessCatalogLane[],
): HarnessDoctorCheck[] {
  return [
    metadataCheck("metadata-lanes", "Lane metadata", validateLanes(lanes)),
    metadataCheck("metadata-scenario-ids", "Scenario ids", validateScenarioIds(lanes)),
    metadataCheck("metadata-scenario-names", "Scenario names", validateScenarioNames(lanes)),
    metadataCheck("metadata-tags", "Scenario tags", validateScenarioTags(lanes)),
  ];
}

export function writeHarnessDoctorReport(
  artifactDir: string,
  report: HarnessDoctorReport,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(artifactDir, { recursive: true });
  const jsonPath = join(artifactDir, "doctor.json");
  const markdownPath = join(artifactDir, "doctor.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderHarnessDoctorMarkdown(report));
  return { jsonPath, markdownPath };
}

export function buildHarnessReport(
  options: {
    manifests: readonly HarnessArtifactManifest[];
    requiredLanes: readonly HarnessLane[];
    optionalLanes?: readonly HarnessLane[];
    doctor?: HarnessDoctorReport | null;
    generatedAt?: string;
  },
): HarnessReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const manifestsByLane = new Map(options.manifests.map((manifest) => [manifest.lane, manifest]));
  const laneOrder = uniquePreserveOrder([
    ...options.requiredLanes,
    ...(options.optionalLanes ?? []),
    ...options.manifests.map((manifest) => manifest.lane),
  ]);
  const missingRequiredLanes = options.requiredLanes.filter((lane) => !manifestsByLane.has(lane));
  const missingOptionalLanes = (options.optionalLanes ?? []).filter((lane) => !manifestsByLane.has(lane));
  const lanes = laneOrder.map((lane): HarnessReportLane => {
    const manifest = manifestsByLane.get(lane);
    if (!manifest) {
      return {
        lane,
        status: "missing",
        total: 0,
        passed: 0,
        failed: 0,
      };
    }
    return {
      lane,
      status: manifest.status,
      total: manifest.total,
      passed: manifest.passed,
      failed: manifest.failed,
      artifactPath: manifest.results.find((result) => result.artifactPath)?.artifactPath,
      generatedAt: manifest.generatedAt,
    };
  });
  const doctor = options.doctor
    ? {
        status: options.doctor.status,
        checks: options.doctor.checks.length,
        passed: options.doctor.checks.filter((check) => check.status === "passed").length,
        warnings: options.doctor.checks.filter((check) => check.status === "warning").length,
        failed: options.doctor.checks.filter((check) => check.status === "failed").length,
      }
    : undefined;
  const hasFailedLane = lanes.some((lane) => lane.status === "failed");
  const hasMissingRequiredLane = missingRequiredLanes.length > 0;
  const doctorFailed = doctor?.status === "failed";
  const doctorWarning = doctor?.status === "warning";
  return {
    schemaVersion: 1,
    generatedAt,
    status: hasMissingRequiredLane || hasFailedLane || doctorFailed
      ? "failed"
      : doctorWarning
        ? "warning"
        : "passed",
    lanes,
    missingRequiredLanes,
    missingOptionalLanes,
    doctor,
  };
}

export function writeHarnessReport(
  artifactDir: string,
  options: {
    manifests: readonly HarnessArtifactManifest[];
    requiredLanes: readonly HarnessLane[];
    optionalLanes?: readonly HarnessLane[];
    doctor?: HarnessDoctorReport | null;
  },
): { jsonPath: string; markdownPath: string; report: HarnessReport } {
  mkdirSync(artifactDir, { recursive: true });
  const report = buildHarnessReport(options);
  const jsonPath = join(artifactDir, "report.json");
  const markdownPath = join(artifactDir, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderHarnessReportMarkdown(report));
  return { jsonPath, markdownPath, report };
}

export function validateHarnessArtifactBundle(
  artifactRoot: string,
  generatedAt = new Date().toISOString(),
): HarnessArtifactValidationReport {
  const checks: HarnessArtifactValidationCheck[] = [];
  const manifests = new Map<HarnessLane, HarnessArtifactManifest>();
  const laneDirs: Array<{ lane: HarnessLane; dir: string; required: boolean }> = [
    { lane: "runtime", dir: "runtime-harness", required: true },
    { lane: "tool-contract", dir: "tool-contract-harness", required: true },
    { lane: "acceptance", dir: "acceptance", required: true },
    { lane: "desktop-e2e", dir: "desktop-e2e", required: false },
  ];

  for (const laneDir of laneDirs) {
    const manifestPath = join(artifactRoot, laneDir.dir, "manifest.json");
    const manifest = readJsonIfPresent<HarnessArtifactManifest>(manifestPath);
    if (!manifest) {
      checks.push(validationCheck(
        `manifest-${laneDir.lane}`,
        laneDir.required ? "failed" : "passed",
        laneDir.required ? "required manifest is missing" : "optional manifest is missing",
        manifestPath,
        laneDir.required
          ? {
              expected: "manifest.json generated by the lane harness",
              actual: "missing",
              hint: "Run bun run harness:ci, or run the specific harness lane that owns this artifact.",
            }
          : {},
      ));
      continue;
    }

    const manifestErrors = validateManifestShape(manifest, laneDir.lane);
    checks.push(validationCheck(
      `manifest-${laneDir.lane}`,
      manifestErrors.length === 0 ? "passed" : "failed",
      manifestErrors.length === 0 ? "manifest schema ok" : manifestErrors.join("; "),
      manifestPath,
      manifestErrors.length === 0
        ? {}
        : {
            expected: `schemaVersion=1, lane=${laneDir.lane}, consistent status/counts/results`,
            actual: manifestErrors.join("; "),
            hint: "Re-run the lane harness and inspect its manifest writer.",
          },
    ));
    if (manifestErrors.length === 0) manifests.set(laneDir.lane, manifest);

    const junitPath = join(artifactRoot, laneDir.dir, "junit.xml");
    checks.push(validateJUnitFile(junitPath, manifest));
  }

  checks.push(validateCatalogFile(join(artifactRoot, "harness-catalog", "catalog.json")));
  const doctor = readJsonIfPresent<HarnessDoctorReport>(join(artifactRoot, "harness-catalog", "doctor.json"));
  checks.push(validateDoctorFile(join(artifactRoot, "harness-catalog", "doctor.json"), doctor));
  checks.push(validateReportFile(join(artifactRoot, "harness-report", "report.json"), manifests, doctor));
  checks.push(validateCiSummaryFile(join(artifactRoot, "harness-report", "ci-summary.json")));

  return {
    schemaVersion: 1,
    generatedAt,
    status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
    checks,
  };
}

export function writeHarnessArtifactValidationReport(
  artifactDir: string,
  report: HarnessArtifactValidationReport,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(artifactDir, { recursive: true });
  const jsonPath = join(artifactDir, "artifact-validation.json");
  const markdownPath = join(artifactDir, "artifact-validation.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderHarnessArtifactValidationMarkdown(report));
  return { jsonPath, markdownPath };
}

export function findHarnessRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
          name?: string;
          workspaces?: unknown;
        };
        if (parsed.name === "vulture" || parsed.workspaces !== undefined) return current;
      } catch {
        // Keep walking; malformed package files should not hide a parent root.
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function buildHarnessSummary(
  lane: HarnessLane,
  results: readonly HarnessResultReport[],
): HarnessSuiteSummary {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  return {
    lane,
    status: failed === 0 ? "passed" : "failed",
    total: results.length,
    passed,
    failed,
    results: [...results],
  };
}

export function writeHarnessManifest(
  artifactDir: string,
  lane: HarnessLane,
  results: readonly HarnessResultReport[],
): string {
  mkdirSync(artifactDir, { recursive: true });
  const manifest: HarnessArtifactManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...buildHarnessSummary(lane, results),
  };
  const path = join(artifactDir, "manifest.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

export function writeHarnessJUnitReport(
  artifactDir: string,
  lane: HarnessLane,
  results: readonly HarnessResultReport[],
): string {
  mkdirSync(artifactDir, { recursive: true });
  const failures = results.filter((result) => result.status === "failed").length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xml(`vulture.${lane}`)}" tests="${results.length}" failures="${failures}">`,
  ];
  for (const result of results) {
    const duration = result.durationMs === undefined ? "" : ` time="${(result.durationMs / 1000).toFixed(3)}"`;
    lines.push(`  <testcase classname="${xml(`vulture.${lane}`)}" name="${xml(result.name)}"${duration}>`);
    const failedStep = result.steps?.find((step) => step.status === "failed");
    const message = failedStep
      ? `${failedStep.name}: ${failedStep.error ?? "unknown failure"}`
      : result.error;
    if (message) {
      lines.push(`    <failure message="${xml(message)}">${xml(message)}</failure>`);
    }
    if (result.artifactPath) lines.push(`    <system-out>${xml(result.artifactPath)}</system-out>`);
    lines.push("  </testcase>");
  }
  lines.push("</testsuite>");
  const path = join(artifactDir, "junit.xml");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

export function writeHarnessFailureReport(
  artifactDir: string,
  options: {
    title: string;
    results: readonly HarnessResultReport[];
  },
): string | null {
  const path = join(artifactDir, "failure-report.md");
  const failed = options.results.filter((result) => result.status === "failed");
  if (failed.length === 0) {
    rmSync(path, { force: true });
    return null;
  }

  mkdirSync(artifactDir, { recursive: true });
  const lines = [`# ${options.title}`, "", `Failed: ${failed.length}/${options.results.length}`, ""];
  for (const result of failed) {
    const failedSteps = result.steps?.filter((step) => step.status === "failed") ?? [];
    const primary = failedSteps[0];
    lines.push(`## ${result.id}`, "", `Name: ${result.name}`);
    if (result.artifactPath) lines.push(`Artifacts: ${result.artifactPath}`);
    if (primary) {
      lines.push(`Failed step: ${primary.name}`, "Error:", fencedMarkdown(primary.error ?? "unknown failure"));
    } else if (result.error) {
      lines.push("Error:", fencedMarkdown(result.error));
    }
    const additional = failedSteps.slice(1);
    if (additional.length > 0) {
      lines.push("", "Additional failures:");
      for (const step of additional) {
        lines.push(step.name, "Error:", fencedMarkdown(step.error ?? "unknown failure"));
      }
    }
    lines.push("");
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderHarnessCatalogMarkdown(catalog: HarnessCatalog): string {
  const lines = [
    "# Harness Catalog",
    "",
    `Generated: ${catalog.generatedAt}`,
    "",
    "## Lanes",
    "",
  ];
  for (const lane of catalog.lanes) {
    lines.push(
      `- ${lane.lane}: ${lane.scenarioCount} scenarios${lane.description ? ` — ${lane.description}` : ""}`,
    );
  }
  lines.push("", "## Tags", "");
  for (const tag of catalog.tags) {
    lines.push(`- ${tag.tag}: ${tag.scenarioCount} scenarios (${tag.lanes.join(", ")})`);
  }
  lines.push("", "## Scenarios", "");
  for (const scenario of catalog.scenarios) {
    lines.push(
      `- [${scenario.lane}] ${scenario.id} — ${scenario.name}` +
        (scenario.tags.length > 0 ? ` (${scenario.tags.join(", ")})` : ""),
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderHarnessDoctorMarkdown(report: HarnessDoctorReport): string {
  const lines = [
    "# Harness Doctor",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    "",
    "## Summary",
    "",
    `- Lanes: ${report.summary.laneCount}`,
    `- Scenarios: ${report.summary.scenarioCount}`,
    `- Tags: ${report.summary.tagCount}`,
    "",
    "## Checks",
    "",
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.status.toUpperCase()} ${check.id}: ${check.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderHarnessReportMarkdown(report: HarnessReport): string {
  const lines = [
    "# Harness Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    "",
    "## Lanes",
    "",
  ];
  for (const lane of report.lanes) {
    if (lane.status === "missing") {
      lines.push(`- MISSING ${lane.lane}`);
      continue;
    }
    lines.push(`- ${lane.status.toUpperCase()} ${lane.lane}: ${lane.passed}/${lane.total} passed`);
  }
  if (report.missingRequiredLanes.length > 0) {
    lines.push("", "## Missing Required Lanes", "");
    for (const lane of report.missingRequiredLanes) lines.push(`- ${lane}`);
  }
  if (report.missingOptionalLanes.length > 0) {
    lines.push("", "## Missing Optional Lanes", "");
    for (const lane of report.missingOptionalLanes) lines.push(`- ${lane}`);
  }
  if (report.doctor) {
    lines.push(
      "",
      "## Doctor",
      "",
      `- Status: ${report.doctor.status}`,
      `- Checks: ${report.doctor.passed}/${report.doctor.checks} passed`,
      `- Warnings: ${report.doctor.warnings}`,
      `- Failed: ${report.doctor.failed}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderHarnessArtifactValidationMarkdown(report: HarnessArtifactValidationReport): string {
  const lines = [
    "# Harness Artifact Validation",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    "",
    "## Checks",
    "",
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.status.toUpperCase()} ${check.id}: ${check.detail}`);
    if (check.status === "failed") {
      if (check.path) lines.push(`  - Path: ${check.path}`);
      if (check.expected) lines.push(`  - Expected: ${check.expected}`);
      if (check.actual) lines.push(`  - Actual: ${check.actual}`);
      if (check.hint) lines.push(`  - Hint: ${check.hint}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function inspectCatalogRule(
  catalog: HarnessCatalog,
  rule: HarnessDoctorRule,
): HarnessDoctorCheck {
  const severity = rule.severity ?? "error";
  const matches = catalog.scenarios.filter((scenario) => {
    if (rule.lane && scenario.lane !== rule.lane) return false;
    if (rule.tag && !scenario.tags.includes(rule.tag)) return false;
    return true;
  });
  const minScenarios = rule.minScenarios ?? 1;
  if (matches.length >= minScenarios) {
    return {
      id: rule.id,
      name: rule.name,
      status: "passed",
      detail: `${rule.name}: ${matches.length}/${minScenarios} scenarios covered`,
    };
  }
  return {
    id: rule.id,
    name: rule.name,
    status: severity === "warning" ? "warning" : "failed",
    detail: `${rule.name}: expected at least ${minScenarios}, found ${matches.length}`,
  };
}

function metadataCheck(
  id: string,
  name: string,
  errors: readonly string[],
): HarnessDoctorCheck {
  if (errors.length === 0) {
    return {
      id,
      name,
      status: "passed",
      detail: `${name}: ok`,
    };
  }
  return {
    id,
    name,
    status: "failed",
    detail: `${name}: ${errors.join("; ")}`,
  };
}

function validateLanes(lanes: readonly HarnessCatalogLane[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (!HARNESS_ID_PATTERN.test(lane.lane)) {
      errors.push(`invalid lane "${lane.lane}"`);
    }
    if (seen.has(lane.lane)) {
      errors.push(`duplicate lane "${lane.lane}"`);
    }
    seen.add(lane.lane);
    if (lane.scenarios.length === 0) {
      errors.push(`lane "${lane.lane}" has no scenarios`);
    }
  }
  return errors;
}

function validateScenarioIds(lanes: readonly HarnessCatalogLane[]): string[] {
  const errors: string[] = [];
  for (const lane of lanes) {
    const seen = new Set<string>();
    for (const scenario of lane.scenarios) {
      if (!HARNESS_ID_PATTERN.test(scenario.id)) {
        errors.push(`${lane.lane}:${scenario.id || "<empty>"} invalid id`);
      }
      if (seen.has(scenario.id)) {
        errors.push(`${lane.lane}:${scenario.id} duplicate id`);
      }
      seen.add(scenario.id);
    }
  }
  return errors;
}

function validateScenarioNames(lanes: readonly HarnessCatalogLane[]): string[] {
  const errors: string[] = [];
  for (const lane of lanes) {
    for (const scenario of lane.scenarios) {
      if (!scenario.name.trim()) {
        errors.push(`${lane.lane}:${scenario.id} missing name`);
      }
    }
  }
  return errors;
}

function validateScenarioTags(lanes: readonly HarnessCatalogLane[]): string[] {
  const errors: string[] = [];
  for (const lane of lanes) {
    for (const scenario of lane.scenarios) {
      const seen = new Set<string>();
      for (const tag of scenario.tags ?? []) {
        if (!HARNESS_ID_PATTERN.test(tag)) {
          errors.push(`${lane.lane}:${scenario.id} invalid tag "${tag}"`);
        }
        if (seen.has(tag)) {
          errors.push(`${lane.lane}:${scenario.id} duplicate tag "${tag}"`);
        }
        seen.add(tag);
      }
    }
  }
  return errors;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function uniquePreserveOrder<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function validationCheck(
  id: string,
  status: HarnessStatus,
  detail: string,
  path?: string,
  extra: {
    expected?: string;
    actual?: string;
    hint?: string;
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

function readJsonIfPresent<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function validateManifestShape(manifest: HarnessArtifactManifest, expectedLane: HarnessLane): string[] {
  const errors: string[] = [];
  if (!isRecord(manifest)) return ["manifest is not an object"];
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (manifest.lane !== expectedLane) errors.push(`lane must be ${expectedLane}`);
  if (!isHarnessStatus(manifest.status)) errors.push("status must be passed or failed");
  if (!Number.isInteger(manifest.total) || manifest.total < 0) errors.push("total must be a non-negative integer");
  if (!Number.isInteger(manifest.passed) || manifest.passed < 0) errors.push("passed must be a non-negative integer");
  if (!Number.isInteger(manifest.failed) || manifest.failed < 0) errors.push("failed must be a non-negative integer");
  if (Number.isInteger(manifest.total) && Number.isInteger(manifest.passed) && Number.isInteger(manifest.failed)) {
    if (manifest.passed + manifest.failed !== manifest.total) errors.push("passed + failed must equal total");
    const expectedStatus = manifest.failed === 0 ? "passed" : "failed";
    if (manifest.status !== expectedStatus) errors.push(`status must be ${expectedStatus}`);
  }
  if (!Array.isArray(manifest.results)) {
    errors.push("results must be an array");
  } else {
    if (Number.isInteger(manifest.total) && manifest.results.length !== manifest.total) {
      errors.push("results length must equal total");
    }
    for (const [index, result] of manifest.results.entries()) {
      if (!isRecord(result)) {
        errors.push(`results[${index}] must be an object`);
        continue;
      }
      if (typeof result.id !== "string" || !result.id) errors.push(`results[${index}].id is required`);
      if (typeof result.name !== "string" || !result.name) errors.push(`results[${index}].name is required`);
      if (!isHarnessStatus(result.status)) errors.push(`results[${index}].status is invalid`);
    }
  }
  return errors;
}

function validateJUnitFile(path: string, manifest: HarnessArtifactManifest): HarnessArtifactValidationCheck {
  if (!existsSync(path)) return validationCheck(`junit-${manifest.lane}`, "failed", "junit.xml is missing", path, {
    expected: "junit.xml generated next to manifest.json",
    actual: "missing",
    hint: "Re-run the lane harness and inspect its JUnit writer.",
  });
  const content = readFileSync(path, "utf8");
  const testSuite = content.match(/<testsuite\b[^>]*>/)?.[0];
  if (!testSuite) return validationCheck(`junit-${manifest.lane}`, "failed", "testsuite element is missing", path, {
    expected: "a <testsuite> element with tests and failures attributes",
    actual: "missing testsuite element",
    hint: "Inspect the generated junit.xml file.",
  });
  const tests = Number(testSuite.match(/\btests="(\d+)"/)?.[1]);
  const failures = Number(testSuite.match(/\bfailures="(\d+)"/)?.[1]);
  const errors: string[] = [];
  if (tests !== manifest.total) errors.push(`tests must equal manifest total ${manifest.total}`);
  if (failures !== manifest.failed) errors.push(`failures must equal manifest failed ${manifest.failed}`);
  const testcaseCount = Array.from(content.matchAll(/<testcase\b/g)).length;
  if (testcaseCount !== manifest.total) errors.push(`testcase count must equal manifest total ${manifest.total}`);
  return validationCheck(
    `junit-${manifest.lane}`,
    errors.length === 0 ? "passed" : "failed",
    errors.length === 0 ? "junit schema ok" : errors.join("; "),
    path,
    errors.length === 0
      ? {}
      : {
          expected: `tests=${manifest.total}, failures=${manifest.failed}, testcase count=${manifest.total}`,
          actual: `tests=${Number.isNaN(tests) ? "missing" : tests}, failures=${Number.isNaN(failures) ? "missing" : failures}, testcase count=${testcaseCount}`,
          hint: "Compare junit.xml with the lane manifest and fix the JUnit writer.",
        },
  );
}

function validateCatalogFile(path: string): HarnessArtifactValidationCheck {
  const catalog = readJsonIfPresent<HarnessCatalog>(path);
  if (!catalog) return validationCheck("catalog", "failed", "catalog.json is missing or invalid JSON", path, {
    expected: "valid harness catalog JSON",
    actual: "missing or invalid JSON",
    hint: "Run bun run harness:catalog.",
  });
  const errors: string[] = [];
  if (catalog.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!Array.isArray(catalog.lanes)) errors.push("lanes must be an array");
  if (!Array.isArray(catalog.tags)) errors.push("tags must be an array");
  if (!Array.isArray(catalog.scenarios)) errors.push("scenarios must be an array");
  if (Array.isArray(catalog.lanes) && Array.isArray(catalog.scenarios)) {
    const laneScenarioCount = catalog.lanes.reduce((sum, lane) => sum + lane.scenarioCount, 0);
    if (laneScenarioCount !== catalog.scenarios.length) errors.push("lane scenario counts must equal scenarios length");
  }
  return validationCheck("catalog", errors.length === 0 ? "passed" : "failed", errors.length === 0 ? "catalog schema ok" : errors.join("; "), path, errors.length === 0 ? {} : {
    expected: "catalog lane counts, tags, and scenarios to be internally consistent",
    actual: errors.join("; "),
    hint: "Run bun run harness:catalog and inspect scenario metadata.",
  });
}

function validateDoctorFile(path: string, report: HarnessDoctorReport | null): HarnessArtifactValidationCheck {
  if (!report) return validationCheck("doctor", "failed", "doctor.json is missing or invalid JSON", path, {
    expected: "valid doctor.json",
    actual: "missing or invalid JSON",
    hint: "Run bun run harness:doctor.",
  });
  const errors = validateDoctorShape(report);
  return validationCheck("doctor", errors.length === 0 ? "passed" : "failed", errors.length === 0 ? "doctor schema ok" : errors.join("; "), path, errors.length === 0 ? {} : {
    expected: "doctor status to match check statuses",
    actual: errors.join("; "),
    hint: "Inspect doctor.json checks and status aggregation.",
  });
}

function validateDoctorShape(report: HarnessDoctorReport): string[] {
  const errors: string[] = [];
  if (!isRecord(report)) return ["doctor report is not an object"];
  if (report.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!["passed", "warning", "failed"].includes(report.status)) errors.push("status is invalid");
  if (!Array.isArray(report.checks)) {
    errors.push("checks must be an array");
    return errors;
  }
  const failed = report.checks.some((check) => check.status === "failed");
  const warned = report.checks.some((check) => check.status === "warning");
  const expected = failed ? "failed" : warned ? "warning" : "passed";
  if (report.status !== expected) errors.push(`status must be ${expected}`);
  return errors;
}

function validateReportFile(
  path: string,
  manifests: ReadonlyMap<HarnessLane, HarnessArtifactManifest>,
  doctor: HarnessDoctorReport | null,
): HarnessArtifactValidationCheck {
  const report = readJsonIfPresent<HarnessReport>(path);
  if (!report) return validationCheck("harness-report", "failed", "report.json is missing or invalid JSON", path, {
    expected: "valid aggregate harness report JSON",
    actual: "missing or invalid JSON",
    hint: "Run bun run harness:report.",
  });
  const errors: string[] = [];
  if (report.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!Array.isArray(report.lanes)) errors.push("lanes must be an array");
  if (!Array.isArray(report.missingRequiredLanes)) errors.push("missingRequiredLanes must be an array");
  for (const lane of ["runtime", "tool-contract", "acceptance"] as const) {
    const manifest = manifests.get(lane);
    const reportLane = report.lanes.find((item) => item.lane === lane);
    if (!manifest) {
      errors.push(`${lane} manifest missing`);
      continue;
    }
    if (!reportLane) {
      errors.push(`${lane} report lane missing`);
      continue;
    }
    if (reportLane.status !== manifest.status) errors.push(`${lane} status must match manifest`);
    if (reportLane.total !== manifest.total) errors.push(`${lane} total must match manifest`);
    if (reportLane.passed !== manifest.passed) errors.push(`${lane} passed must match manifest`);
    if (reportLane.failed !== manifest.failed) errors.push(`${lane} failed must match manifest`);
  }
  if (doctor) {
    if (!report.doctor) {
      errors.push("doctor summary is missing");
    } else {
      const doctorPassed = doctor.checks.filter((check) => check.status === "passed").length;
      const doctorWarnings = doctor.checks.filter((check) => check.status === "warning").length;
      const doctorFailed = doctor.checks.filter((check) => check.status === "failed").length;
      if (report.doctor.status !== doctor.status) errors.push("doctor status must match doctor.json");
      if (report.doctor.checks !== doctor.checks.length) errors.push("doctor checks must match doctor.json");
      if (report.doctor.passed !== doctorPassed) errors.push("doctor passed count must match doctor.json");
      if (report.doctor.warnings !== doctorWarnings) errors.push("doctor warning count must match doctor.json");
      if (report.doctor.failed !== doctorFailed) errors.push("doctor failed count must match doctor.json");
    }
  }
  const failedLane = report.lanes.some((lane) => lane.status === "failed");
  const missingRequired = report.missingRequiredLanes.length > 0;
  const doctorFailed = report.doctor?.status === "failed";
  const doctorWarning = report.doctor?.status === "warning";
  const expectedStatus = missingRequired || failedLane || doctorFailed ? "failed" : doctorWarning ? "warning" : "passed";
  if (report.status !== expectedStatus) errors.push(`status must be ${expectedStatus}`);
  return validationCheck("harness-report", errors.length === 0 ? "passed" : "failed", errors.length === 0 ? "report schema ok" : errors.join("; "), path, errors.length === 0 ? {} : {
    expected: "aggregate report lanes and doctor summary to match source artifacts",
    actual: errors.join("; "),
    hint: "Open harness-report/report.json next to the lane manifest and doctor files.",
  });
}

function validateCiSummaryFile(path: string): HarnessArtifactValidationCheck {
  if (!existsSync(path)) return validationCheck("ci-summary", "passed", "ci-summary.json is not present");
  const summary = readJsonIfPresent<{
    schemaVersion: number;
    status: HarnessStatus;
    total: number;
    passed: number;
    failed: number;
    steps: Array<{ status: HarnessStatus }>;
  }>(path);
  if (!summary) return validationCheck("ci-summary", "failed", "ci-summary.json is invalid JSON", path, {
    expected: "valid CI summary JSON",
    actual: "invalid JSON",
    hint: "Run bun run harness:ci to regenerate ci-summary.json.",
  });
  const errors: string[] = [];
  if (summary.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!isHarnessStatus(summary.status)) errors.push("status must be passed or failed");
  if (!Array.isArray(summary.steps)) errors.push("steps must be an array");
  if (Array.isArray(summary.steps)) {
    const passed = summary.steps.filter((step) => step.status === "passed").length;
    const failed = summary.steps.length - passed;
    if (summary.total !== summary.steps.length) errors.push("total must equal steps length");
    if (summary.passed !== passed) errors.push("passed must equal passed steps");
    if (summary.failed !== failed) errors.push("failed must equal failed steps");
    const expectedStatus = failed === 0 ? "passed" : "failed";
    if (summary.status !== expectedStatus) errors.push(`status must be ${expectedStatus}`);
  }
  return validationCheck("ci-summary", errors.length === 0 ? "passed" : "failed", errors.length === 0 ? "ci summary schema ok" : errors.join("; "), path, errors.length === 0 ? {} : {
    expected: "ci summary counts and status to match step statuses",
    actual: errors.join("; "),
    hint: "Open ci-summary.json and inspect the failed step accounting.",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHarnessStatus(value: unknown): value is HarnessStatus {
  return value === "passed" || value === "failed";
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function separatedValue(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("--")) throw new Error(message);
  return trimmed;
}

function fencedMarkdown(value: string): string {
  const longestFence = Math.max(3, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return `${fence}\n${value}\n${fence}`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
