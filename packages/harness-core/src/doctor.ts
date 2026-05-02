import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessCatalog, HarnessCatalogLane } from "./catalog";
import type { HarnessLane } from "./shared";

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
