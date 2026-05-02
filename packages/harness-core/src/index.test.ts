import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHarnessSummary,
  buildHarnessReport,
  buildHarnessCatalog,
  buildHarnessDoctorReport,
  formatHarnessListLine,
  inspectHarnessCatalog,
  inspectHarnessCatalogLanes,
  parseHarnessCliArgs,
  selectHarnessScenarios,
  writeHarnessCatalog,
  validateHarnessArtifactBundle,
  writeHarnessArtifactValidationReport,
  writeHarnessDoctorReport,
  writeHarnessFailureReport,
  writeHarnessJUnitReport,
  writeHarnessManifest,
  writeHarnessReport,
} from "./index";

const scenarios = [
  { id: "launch", name: "Launch", tags: ["desktop", "smoke"] },
  { id: "restore", name: "Restore", tags: ["desktop", "recovery"] },
  { id: "tools", name: "Tools", tags: ["gateway", "tools"] },
];

describe("harness-core", () => {
  test("parses list, ids, tags, artifact dir, and environment defaults", () => {
    expect(
      parseHarnessCliArgs(
        ["--list", "--scenario", "launch", "--tag=recovery,smoke", "--artifact-dir", "/tmp/out"],
        { VULTURE_SCENARIOS: "restore", VULTURE_TAGS: "desktop" },
        {
          idEnv: "VULTURE_SCENARIOS",
          tagEnv: "VULTURE_TAGS",
        },
      ),
    ).toEqual({
      list: true,
      ids: ["restore", "launch"],
      tags: ["desktop", "recovery", "smoke"],
      artifactDir: "/tmp/out",
    });
  });

  test("supports lane-specific flag names", () => {
    expect(
      parseHarnessCliArgs(["--tool", "read", "--category", "fs,runtime"], {}, {
        idFlag: "tool",
        tagFlag: "category",
      }),
    ).toEqual({
      list: false,
      ids: ["read"],
      tags: ["fs", "runtime"],
      artifactDir: undefined,
    });
  });

  test("selects explicit ids before tag filters and dedupes ids", () => {
    expect(
      selectHarnessScenarios(scenarios, {
        ids: ["restore", "launch", "restore"],
        tags: ["tools"],
      }).map((scenario) => scenario.id),
    ).toEqual(["restore", "launch"]);
  });

  test("selects by tags and reports useful errors", () => {
    expect(
      selectHarnessScenarios(scenarios, { tags: ["tools"] }).map((scenario) => scenario.id),
    ).toEqual(["tools"]);
    expect(() => selectHarnessScenarios(scenarios, { ids: ["missing"] })).toThrow(
      "Unknown scenario: missing",
    );
    expect(() => selectHarnessScenarios(scenarios, { tags: ["missing"] })).toThrow(
      "No scenarios match tags: missing",
    );
  });

  test("formats list lines", () => {
    expect(formatHarnessListLine(scenarios[0]!)).toBe("launch\tLaunch\tdesktop,smoke");
  });

  test("builds and writes a cross-lane harness catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-harness-catalog-"));
    try {
      const catalog = buildHarnessCatalog(
        [
          { lane: "runtime", description: "Runtime lane", scenarios: [scenarios[0]!] },
          { lane: "desktop-e2e", scenarios: [scenarios[1]!, scenarios[2]!] },
        ],
        "2026-05-02T00:00:00.000Z",
      );
      expect(catalog.lanes).toEqual([
        {
          lane: "runtime",
          description: "Runtime lane",
          scenarioCount: 1,
          tags: ["desktop", "smoke"],
        },
        {
          lane: "desktop-e2e",
          description: null,
          scenarioCount: 2,
          tags: ["desktop", "gateway", "recovery", "tools"],
        },
      ]);
      expect(catalog.tags.find((tag) => tag.tag === "desktop")).toMatchObject({
        scenarioCount: 2,
        lanes: ["desktop-e2e", "runtime"],
      });

      const written = writeHarnessCatalog(dir, [
        { lane: "runtime", scenarios: [scenarios[0]!] },
      ]);
      expect(written.jsonPath).toBe(join(dir, "catalog.json"));
      expect(written.markdownPath).toBe(join(dir, "catalog.md"));
      expect(JSON.parse(readFileSync(written.jsonPath, "utf8")).schemaVersion).toBe(1);
      expect(readFileSync(written.markdownPath, "utf8")).toContain("[runtime] launch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inspects catalog coverage and writes doctor reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-harness-doctor-"));
    try {
      const catalog = buildHarnessCatalog(
        [
          { lane: "runtime", scenarios: [scenarios[0]!] },
          { lane: "desktop-e2e", scenarios: [scenarios[1]!] },
        ],
        "2026-05-02T00:00:00.000Z",
      );
      const report = inspectHarnessCatalog(catalog, [
        { id: "runtime", name: "Runtime lane", lane: "runtime" },
        { id: "browser", name: "Browser tag", tag: "browser", severity: "warning" },
        { id: "desktop-smoke", name: "Desktop smoke", lane: "desktop-e2e", tag: "smoke" },
      ], "2026-05-02T00:00:00.000Z");

      expect(report.status).toBe("failed");
      expect(report.checks.map((check) => [check.id, check.status])).toEqual([
        ["runtime", "passed"],
        ["browser", "warning"],
        ["desktop-smoke", "failed"],
      ]);

      const paths = writeHarnessDoctorReport(dir, report);
      expect(paths.jsonPath).toBe(join(dir, "doctor.json"));
      expect(paths.markdownPath).toBe(join(dir, "doctor.md"));
      expect(JSON.parse(readFileSync(paths.jsonPath, "utf8")).status).toBe("failed");
      expect(readFileSync(paths.markdownPath, "utf8")).toContain("FAILED desktop-smoke");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inspects lane metadata quality", () => {
    expect(
      inspectHarnessCatalogLanes([
        { lane: "runtime", scenarios: [scenarios[0]!] },
        { lane: "desktop-e2e", scenarios: [scenarios[1]!] },
      ]).map((check) => check.status),
    ).toEqual(["passed", "passed", "passed", "passed"]);

    const checks = inspectHarnessCatalogLanes([
      {
        lane: "bad lane",
        scenarios: [
          { id: "bad id", name: "", tags: ["bad tag", "bad tag"] },
          { id: "bad id", name: "Duplicate", tags: [] },
        ],
      },
      { lane: "bad lane", scenarios: [] },
    ]);

    expect(checks.map((check) => check.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(checks.find((check) => check.id === "metadata-lanes")?.detail).toContain(
      'duplicate lane "bad lane"',
    );
    expect(checks.find((check) => check.id === "metadata-scenario-ids")?.detail).toContain(
      "duplicate id",
    );
    expect(checks.find((check) => check.id === "metadata-tags")?.detail).toContain(
      'duplicate tag "bad tag"',
    );
  });

  test("writes manifest, junit, and failure report", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-harness-core-"));
    try {
      const results = [
        {
          id: "launch",
          name: "Launch",
          status: "passed" as const,
          artifactPath: "/tmp/launch",
          steps: [{ name: "launchApp", status: "passed" as const }],
        },
        {
          id: "restore",
          name: "Restore <flow>",
          status: "failed" as const,
          artifactPath: "/tmp/restore",
          steps: [{ name: "wait", status: "failed" as const, error: "not ready & timed out" }],
        },
      ];

      expect(buildHarnessSummary("desktop-e2e", results)).toMatchObject({
        lane: "desktop-e2e",
        status: "failed",
        total: 2,
        passed: 1,
        failed: 1,
      });
      expect(writeHarnessManifest(dir, "desktop-e2e", results)).toBe(join(dir, "manifest.json"));
      expect(writeHarnessJUnitReport(dir, "desktop-e2e", results)).toBe(join(dir, "junit.xml"));
      expect(writeHarnessFailureReport(dir, { title: "Desktop Failures", results })).toBe(
        join(dir, "failure-report.md"),
      );

      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.lane).toBe("desktop-e2e");
      expect(readFileSync(join(dir, "junit.xml"), "utf8")).toContain("Restore &lt;flow&gt;");
      expect(readFileSync(join(dir, "failure-report.md"), "utf8")).toContain("not ready & timed out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("builds and writes an aggregate harness report", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-harness-report-"));
    try {
      const report = buildHarnessReport({
        generatedAt: "2026-05-02T00:00:00.000Z",
        requiredLanes: ["runtime", "tool-contract", "acceptance"],
        optionalLanes: ["desktop-e2e"],
        manifests: [
          {
            schemaVersion: 1,
            generatedAt: "2026-05-02T00:00:00.000Z",
            lane: "runtime",
            status: "passed",
            total: 1,
            passed: 1,
            failed: 0,
            results: [{ id: "launch", name: "Launch", status: "passed" }],
          },
          {
            schemaVersion: 1,
            generatedAt: "2026-05-02T00:00:00.000Z",
            lane: "tool-contract",
            status: "passed",
            total: 1,
            passed: 1,
            failed: 0,
            results: [{ id: "read", name: "Read", status: "passed" }],
          },
        ],
        doctor: {
          schemaVersion: 1,
          generatedAt: "2026-05-02T00:00:00.000Z",
          status: "passed",
          summary: { laneCount: 2, scenarioCount: 2, tagCount: 1 },
          checks: [{ id: "metadata", name: "Metadata", status: "passed", detail: "ok" }],
        },
      });

      expect(report.status).toBe("failed");
      expect(report.missingRequiredLanes).toEqual(["acceptance"]);
      expect(report.missingOptionalLanes).toEqual(["desktop-e2e"]);
      expect(report.doctor).toMatchObject({ checks: 1, passed: 1, failed: 0 });

      const paths = writeHarnessReport(dir, {
        requiredLanes: ["runtime"],
        manifests: [reportFixtureManifest("runtime")],
      });
      expect(paths.jsonPath).toBe(join(dir, "report.json"));
      expect(paths.markdownPath).toBe(join(dir, "report.md"));
      expect(JSON.parse(readFileSync(paths.jsonPath, "utf8")).status).toBe("passed");
      expect(readFileSync(paths.markdownPath, "utf8")).toContain("PASSED runtime");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes stale failure reports on success", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-harness-core-"));
    try {
      writeHarnessFailureReport(dir, {
        title: "Failures",
        results: [{ id: "restore", name: "Restore", status: "failed", error: "bad" }],
      });
      expect(existsSync(join(dir, "failure-report.md"))).toBe(true);
      expect(
        writeHarnessFailureReport(dir, {
          title: "Failures",
          results: [{ id: "restore", name: "Restore", status: "passed" }],
        }),
      ).toBeNull();
      expect(existsSync(join(dir, "failure-report.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validates a complete harness artifact bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-artifacts-"));
    try {
      const manifests = [
        writeLaneArtifacts(root, "runtime", "runtime-harness"),
        writeLaneArtifacts(root, "tool-contract", "tool-contract-harness"),
        writeLaneArtifacts(root, "acceptance", "acceptance"),
      ];
      const catalog = buildHarnessCatalog([
        { lane: "runtime", scenarios: [scenarios[0]!] },
        { lane: "tool-contract", scenarios: [scenarios[1]!] },
        { lane: "acceptance", scenarios: [scenarios[2]!] },
      ]);
      writeHarnessCatalog(join(root, "harness-catalog"), [
        { lane: "runtime", scenarios: [scenarios[0]!] },
        { lane: "tool-contract", scenarios: [scenarios[1]!] },
        { lane: "acceptance", scenarios: [scenarios[2]!] },
      ]);
      const doctor = buildHarnessDoctorReport(catalog, [
        { id: "metadata", name: "Metadata", status: "passed", detail: "ok" },
      ]);
      writeHarnessDoctorReport(join(root, "harness-catalog"), doctor);
      writeHarnessReport(join(root, "harness-report"), {
        requiredLanes: ["runtime", "tool-contract", "acceptance"],
        optionalLanes: ["desktop-e2e"],
        manifests,
        doctor,
      });
      writeFileSync(
        join(root, "harness-report", "ci-summary.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-05-02T00:00:00.000Z",
          status: "passed",
          total: 1,
          passed: 1,
          failed: 0,
          steps: [{ id: "harness-report", name: "Harness report", command: ["bun"], status: "passed", exitCode: 0, signal: null, durationMs: 1 }],
        })}\n`,
      );

      const report = validateHarnessArtifactBundle(root, "2026-05-02T00:00:00.000Z");
      expect(report.status).toBe("passed");
      expect(report.checks.find((check) => check.id === "junit-runtime")?.status).toBe("passed");
      const paths = writeHarnessArtifactValidationReport(join(root, "harness-report"), report);
      expect(paths.jsonPath).toBe(join(root, "harness-report", "artifact-validation.json"));
      expect(readFileSync(paths.markdownPath, "utf8")).toContain("PASSED harness-report");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails artifact validation when junit counts drift from manifest counts", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-artifacts-"));
    try {
      writeLaneArtifacts(root, "runtime", "runtime-harness");
      writeLaneArtifacts(root, "tool-contract", "tool-contract-harness");
      writeLaneArtifacts(root, "acceptance", "acceptance");
      writeFileSync(
        join(root, "runtime-harness", "junit.xml"),
        '<?xml version="1.0" encoding="UTF-8"?><testsuite name="bad" tests="2" failures="0"><testcase name="one"/></testsuite>\n',
      );

      const report = validateHarnessArtifactBundle(root, "2026-05-02T00:00:00.000Z");
      expect(report.status).toBe("failed");
      expect(report.checks.find((check) => check.id === "junit-runtime")?.detail).toContain(
        "tests must equal manifest total 1",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function reportFixtureManifest(lane: "runtime" | "tool-contract" | "acceptance" | "desktop-e2e") {
  return {
    schemaVersion: 1 as const,
    generatedAt: "2026-05-02T00:00:00.000Z",
    lane,
    status: "passed" as const,
    total: 1,
    passed: 1,
    failed: 0,
    results: [{ id: `${lane}-scenario`, name: lane, status: "passed" as const }],
  };
}

function writeLaneArtifacts(
  root: string,
  lane: "runtime" | "tool-contract" | "acceptance",
  dirName: string,
) {
  const dir = join(root, dirName);
  const results = [{ id: `${lane}-scenario`, name: lane, status: "passed" as const }];
  writeHarnessManifest(dir, lane, results);
  writeHarnessJUnitReport(dir, lane, results);
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}
