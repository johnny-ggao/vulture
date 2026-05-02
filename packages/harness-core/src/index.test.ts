import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildHarnessSummary,
  buildHarnessReport,
  buildHarnessCatalog,
  buildHarnessDoctorReport,
  buildHarnessArtifactHistory,
  buildHarnessTriageReport,
  formatHarnessListLine,
  archiveHarnessArtifacts,
  inspectHarnessCatalog,
  inspectHarnessCatalogLanes,
  parseHarnessCliArgs,
  pruneHarnessArtifactSnapshots,
  selectHarnessScenarios,
  writeHarnessArtifactHistoryReport,
  writeHarnessArtifactRetentionReport,
  writeHarnessTriageReport,
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
      writeValidArtifactBundle(root);

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
      writeValidArtifactBundle(root);
      writeFileSync(
        join(root, "runtime-harness", "junit.xml"),
        '<?xml version="1.0" encoding="UTF-8"?><testsuite name="bad" tests="2" failures="0"><testcase name="one"/></testsuite>\n',
      );

      const report = validateHarnessArtifactBundle(root, "2026-05-02T00:00:00.000Z");
      expect(report.status).toBe("failed");
      const check = report.checks.find((item) => item.id === "junit-runtime");
      expect(check?.detail).toContain(
        "tests must equal manifest total 1",
      );
      expect(check?.expected).toBe("tests=1, failures=0, testcase count=1");
      expect(check?.actual).toBe("tests=2, failures=0, testcase count=1");
      expect(check?.command).toBe("bun run harness:runtime");

      const paths = writeHarnessArtifactValidationReport(join(root, "harness-report"), report);
      const markdown = readFileSync(paths.markdownPath, "utf8");
      expect(markdown).toContain("Expected: tests=1, failures=0, testcase count=1");
      expect(markdown).toContain("Actual: tests=2, failures=0, testcase count=1");
      expect(markdown).toContain("Hint: Compare junit.xml with the lane manifest");
      expect(markdown).toContain("Command: bun run harness:runtime");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails artifact validation when manifest status contradicts failed count", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-artifacts-"));
    try {
      writeValidArtifactBundle(root);
      mutateJson(join(root, "runtime-harness", "manifest.json"), (manifest) => ({
        ...manifest,
        status: "passed",
        passed: 0,
        failed: 1,
        results: [{ id: "runtime-scenario", name: "runtime", status: "failed" }],
      }));

      const report = validateHarnessArtifactBundle(root, "2026-05-02T00:00:00.000Z");
      expect(report.status).toBe("failed");
      expect(report.checks.find((check) => check.id === "manifest-runtime")?.detail).toContain(
        "status must be failed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails artifact validation when aggregate report drifts from lane manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-artifacts-"));
    try {
      writeValidArtifactBundle(root);
      mutateJson(join(root, "harness-report", "report.json"), (report) => ({
        ...report,
        lanes: report.lanes.map((lane: { lane: string; total: number }) =>
          lane.lane === "runtime" ? { ...lane, total: lane.total + 1 } : lane,
        ),
      }));

      const report = validateHarnessArtifactBundle(root, "2026-05-02T00:00:00.000Z");
      expect(report.status).toBe("failed");
      expect(report.checks.find((check) => check.id === "harness-report")?.detail).toContain(
        "runtime total must match manifest",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails artifact validation when doctor status contradicts checks", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-artifacts-"));
    try {
      writeValidArtifactBundle(root);
      mutateJson(join(root, "harness-catalog", "doctor.json"), (doctor) => ({
        ...doctor,
        status: "passed",
        checks: [
          ...doctor.checks,
          { id: "broken", name: "Broken", status: "failed", detail: "broken" },
        ],
      }));

      const report = validateHarnessArtifactBundle(root, "2026-05-02T00:00:00.000Z");
      expect(report.status).toBe("failed");
      expect(report.checks.find((check) => check.id === "doctor")?.detail).toContain(
        "status must be failed",
      );
      expect(report.checks.find((check) => check.id === "harness-report")?.detail).toContain(
        "doctor checks must match doctor.json",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails artifact validation when ci summary counts contradict steps", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-artifacts-"));
    try {
      writeValidArtifactBundle(root);
      mutateJson(join(root, "harness-report", "ci-summary.json"), (summary) => ({
        ...summary,
        passed: 0,
      }));

      const report = validateHarnessArtifactBundle(root, "2026-05-02T00:00:00.000Z");
      expect(report.status).toBe("failed");
      expect(report.checks.find((check) => check.id === "ci-summary")?.detail).toContain(
        "passed must equal passed steps",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("archives harness artifacts and prunes old snapshots by policy", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-retention-"));
    try {
      const artifactRoot = join(root, "current");
      const archiveRoot = join(root, "harness-runs");
      writeFile(join(artifactRoot, "runtime-harness", "manifest.json"));
      writeFile(join(artifactRoot, "harness-report", "ci-summary.json"));

      archiveHarnessArtifacts({
        artifactRoot,
        archiveRoot,
        runId: "run-1",
        status: "passed",
        generatedAt: "2026-05-02T00:00:01.000Z",
      });
      archiveHarnessArtifacts({
        artifactRoot,
        archiveRoot,
        runId: "run-2",
        status: "failed",
        generatedAt: "2026-05-02T00:00:02.000Z",
      });
      archiveHarnessArtifacts({
        artifactRoot,
        archiveRoot,
        runId: "run-3",
        status: "passed",
        generatedAt: "2026-05-02T00:00:03.000Z",
      });
      const latest = archiveHarnessArtifacts({
        artifactRoot,
        archiveRoot,
        runId: "run-4",
        status: "passed",
        generatedAt: "2026-05-02T00:00:04.000Z",
      });

      expect(existsSync(join(latest.path, "runtime-harness", "manifest.json"))).toBe(true);

      const report = pruneHarnessArtifactSnapshots({
        archiveRoot,
        generatedAt: "2026-05-02T00:01:00.000Z",
        policy: { keepLast: 2, keepLatestPassed: true, keepLatestFailed: true },
      });
      expect(report.status).toBe("passed");
      expect(report.kept.map((entry) => entry.id).sort()).toEqual(["run-2", "run-3", "run-4"]);
      expect(report.deleted.map((entry) => entry.id)).toEqual(["run-1"]);
      expect(existsSync(join(archiveRoot, "run-1"))).toBe(false);
      expect(existsSync(join(archiveRoot, "run-2"))).toBe(true);

      const paths = writeHarnessArtifactRetentionReport(join(artifactRoot, "harness-report"), report);
      const markdown = readFileSync(paths.markdownPath, "utf8");
      expect(markdown).toContain("KEPT run-2: latest-failed");
      expect(markdown).toContain("DELETED run-1");

      const history = buildHarnessArtifactHistory(report, "2026-05-02T00:02:00.000Z");
      expect(history.latestStatus).toBe("passed");
      expect(history.entries.map((entry) => entry.id)).toEqual(["run-4", "run-3", "run-2"]);
      expect(history.entries.find((entry) => entry.id === "run-1")).toBeUndefined();
      expect(history.entries.find((entry) => entry.id === "run-2")?.retentionReasons).toEqual([
        "latest-failed",
      ]);
      expect(history.entries[0]?.reportMarkdownPath).toBe(
        join(archiveRoot, "run-4", "harness-report", "report.md"),
      );

      const historyPaths = writeHarnessArtifactHistoryReport(
        join(artifactRoot, "harness-report"),
        history,
      );
      const historyMarkdown = readFileSync(historyPaths.markdownPath, "utf8");
      expect(historyMarkdown).toContain("# Harness Artifact History");
      expect(historyMarkdown).toContain("### run-4");
      expect(historyMarkdown).toContain(`Report: ${join(archiveRoot, "run-4", "harness-report", "report.md")}`);
      expect(historyMarkdown).not.toContain("### run-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("builds and writes failure triage reports", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-triage-"));
    try {
      const report = buildHarnessTriageReport({
        generatedAt: "2026-05-02T00:03:00.000Z",
        ciSteps: [
          {
            id: "runtime-harness",
            name: "Runtime harness",
            command: ["bun", "run", "harness:runtime"],
            status: "failed",
            error: "runtime failed",
          },
          {
            id: "harness-report",
            name: "Harness report",
            command: ["bun", "run", "harness:report"],
            status: "passed",
          },
        ],
        harnessReport: {
          schemaVersion: 1,
          generatedAt: "2026-05-02T00:02:00.000Z",
          status: "failed",
          lanes: [
            {
              lane: "runtime",
              status: "failed",
              total: 2,
              passed: 1,
              failed: 1,
              artifactPath: "/tmp/runtime-failure",
            },
            { lane: "tool-contract", status: "missing", total: 0, passed: 0, failed: 0 },
          ],
          missingRequiredLanes: ["tool-contract"],
          missingOptionalLanes: [],
        },
        artifactValidationReport: {
          schemaVersion: 1,
          generatedAt: "2026-05-02T00:02:30.000Z",
          status: "failed",
          checks: [
            {
              id: "junit-runtime",
              status: "failed",
              detail: "junit drift",
              path: "/tmp/runtime-harness/junit.xml",
              command: "bun run harness:runtime",
            },
            { id: "doctor", status: "passed", detail: "ok" },
          ],
        },
      });

      expect(report.status).toBe("failed");
      expect(report.summary).toEqual({
        total: 4,
        ciSteps: 1,
        lanes: 2,
        artifactValidation: 1,
      });
      expect(report.items.map((item) => item.category)).toEqual([
        "ci-step",
        "lane",
        "lane",
        "artifact-validation",
      ]);

      const paths = writeHarnessTriageReport(join(root, "harness-report"), report);
      const markdown = readFileSync(paths.markdownPath, "utf8");
      expect(JSON.parse(readFileSync(paths.jsonPath, "utf8")).summary.total).toBe(4);
      expect(markdown).toContain("# Harness Failure Triage");
      expect(markdown).toContain("runtime failed");
      expect(markdown).toContain("Artifacts: /tmp/runtime-failure");
      expect(markdown).toContain("Path: /tmp/runtime-harness/junit.xml");
      expect(markdown).toContain("````\nbun run harness:runtime\n````");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes empty triage reports when there are no failures", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-triage-"));
    try {
      const report = buildHarnessTriageReport({
        generatedAt: "2026-05-02T00:04:00.000Z",
        ciSteps: [{
          id: "harness-report",
          name: "Harness report",
          command: ["bun", "run", "harness:report"],
          status: "passed",
        }],
        harnessReport: {
          schemaVersion: 1,
          generatedAt: "2026-05-02T00:03:00.000Z",
          status: "passed",
          lanes: [reportFixtureManifest("runtime")],
          missingRequiredLanes: [],
          missingOptionalLanes: [],
        },
        artifactValidationReport: {
          schemaVersion: 1,
          generatedAt: "2026-05-02T00:03:30.000Z",
          status: "passed",
          checks: [{ id: "manifest-runtime", status: "passed", detail: "ok" }],
        },
      });
      expect(report.status).toBe("passed");
      expect(report.summary.total).toBe(0);

      const paths = writeHarnessTriageReport(join(root, "harness-report"), report);
      expect(readFileSync(paths.markdownPath, "utf8")).toContain("No failures.");
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

function writeValidArtifactBundle(root: string) {
  const manifests = [
    writeLaneArtifacts(root, "runtime", "runtime-harness"),
    writeLaneArtifacts(root, "tool-contract", "tool-contract-harness"),
    writeLaneArtifacts(root, "acceptance", "acceptance"),
  ];
  const lanes = [
    { lane: "runtime" as const, scenarios: [scenarios[0]!] },
    { lane: "tool-contract" as const, scenarios: [scenarios[1]!] },
    { lane: "acceptance" as const, scenarios: [scenarios[2]!] },
  ];
  const catalog = buildHarnessCatalog(lanes);
  writeHarnessCatalog(join(root, "harness-catalog"), lanes);
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
}

function mutateJson(path: string, mutate: (value: any) => any): void {
  writeFileSync(path, `${JSON.stringify(mutate(JSON.parse(readFileSync(path, "utf8"))), null, 2)}\n`);
}

function writeFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "ok\n");
}
