import { describe, expect, test } from "bun:test";
import {
  buildHarnessCatalog,
  buildHarnessDoctorReport,
  inspectHarnessCatalog,
  inspectHarnessCatalogLanes,
} from "@vulture/harness-core";
import { harnessCatalogLanes } from "./harnessCatalog";
import { harnessDoctorRules } from "./harnessDoctor";

describe("harness doctor script", () => {
  test("current harness catalog satisfies required doctor rules", () => {
    const lanes = harnessCatalogLanes();
    const catalog = buildHarnessCatalog(lanes, "2026-05-02T00:00:00.000Z");
    const coverageReport = inspectHarnessCatalog(
      catalog,
      harnessDoctorRules(),
      "2026-05-02T00:00:00.000Z",
    );
    const report = buildHarnessDoctorReport(
      catalog,
      [...inspectHarnessCatalogLanes(lanes), ...coverageReport.checks],
      "2026-05-02T00:00:00.000Z",
    );

    expect(report.status).toBe("passed");
    expect(report.checks.filter((check) => check.status === "failed")).toEqual([]);
    expect(report.checks.map((check) => check.id)).toContain("coverage-browser");
    expect(report.checks.map((check) => check.id)).toContain("metadata-scenario-ids");
    expect(report.summary.scenarioCount).toBeGreaterThan(40);
  });
});
