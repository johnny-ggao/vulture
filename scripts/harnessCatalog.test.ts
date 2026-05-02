import { describe, expect, test } from "bun:test";
import { buildHarnessCatalog } from "@vulture/harness-core";
import { harnessCatalogLanes } from "./harnessCatalog";

describe("harness catalog script", () => {
  test("collects all shipped harness lanes", () => {
    const lanes = harnessCatalogLanes();
    expect(lanes.map((lane) => lane.lane)).toEqual([
      "runtime",
      "tool-contract",
      "acceptance",
      "desktop-e2e",
      "live",
    ]);

    const catalog = buildHarnessCatalog(lanes, "2026-05-02T00:00:00.000Z");
    expect(catalog.scenarios.length).toBeGreaterThan(40);
    expect(catalog.tags.map((tag) => tag.tag)).toContain("subagents");
    expect(catalog.tags.map((tag) => tag.tag)).toContain("browser");
    expect(catalog.lanes.find((lane) => lane.lane === "tool-contract")?.scenarioCount).toBeGreaterThan(20);
  });
});
