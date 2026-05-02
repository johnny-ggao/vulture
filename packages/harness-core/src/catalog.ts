import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  uniqueSorted,
  type HarnessLane,
  type HarnessScenarioLike,
} from "./shared";

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
