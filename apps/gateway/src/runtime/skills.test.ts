import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterSkillEntries,
  formatSkillsForPrompt,
  loadSkillEntries,
  type SkillEntry,
} from "./skills";

function mkdtempPath(): string {
  return join(tmpdir(), `vulture-skills-${crypto.randomUUID()}`);
}

function writeSkill(root: string, dirName: string, body: {
  name: string;
  description: string;
  metadata?: unknown;
  extraFrontmatter?: Record<string, string>;
  content?: string;
}): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${body.name}`,
    `description: ${body.description}`,
    ...(body.metadata === undefined
      ? []
      : [`metadata.openclaw: ${JSON.stringify(body.metadata)}`]),
    ...Object.entries(body.extraFrontmatter ?? {}).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    body.content ?? `# ${body.name}`,
    "",
  ];
  writeFileSync(join(dir, "SKILL.md"), lines.join("\n"));
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("skill runtime", () => {
  test("loads valid workspace skills and renders an available-skills prompt", () => {
    const workspace = mkdtempPath();
    mkdirSync(join(workspace, "skills"), { recursive: true });
    writeSkill(join(workspace, "skills"), "csv", {
      name: "csv-insights",
      description: "Summarize CSV reports.",
    });

    try {
      const entries = loadSkillEntries({ workspaceDir: workspace });
      expect(entries.map((entry) => entry.name)).toEqual(["csv-insights"]);
      const prompt = formatSkillsForPrompt(entries);
      expect(prompt).toContain("<available_skills>");
      expect(prompt).toContain("<name>csv-insights</name>");
      expect(prompt).toContain("<description>Summarize CSV reports.</description>");
      expect(prompt).toContain("<location>");
    } finally {
      cleanup(workspace);
    }
  });

  test("workspace skill overrides profile skill with the same name", () => {
    const workspace = mkdtempPath();
    const profile = mkdtempPath();
    mkdirSync(join(workspace, "skills"), { recursive: true });
    mkdirSync(join(profile, "skills"), { recursive: true });
    writeSkill(join(profile, "skills"), "shared", {
      name: "shared",
      description: "Profile version.",
    });
    writeSkill(join(workspace, "skills"), "shared", {
      name: "shared",
      description: "Workspace version.",
    });

    try {
      const entries = loadSkillEntries({ workspaceDir: workspace, profileDir: profile });
      expect(entries).toHaveLength(1);
      expect(entries[0].description).toBe("Workspace version.");
    } finally {
      cleanup(workspace);
      cleanup(profile);
    }
  });

  test("filters skills by explicit agent allowlist and supports empty disable list", () => {
    const entries: SkillEntry[] = [
      {
        name: "alpha",
        description: "A",
        filePath: "/tmp/alpha/SKILL.md",
        baseDir: "/tmp/alpha",
        modelInvocationEnabled: true,
      },
      {
        name: "beta",
        description: "B",
        filePath: "/tmp/beta/SKILL.md",
        baseDir: "/tmp/beta",
        modelInvocationEnabled: true,
      },
    ];

    expect(filterSkillEntries(entries, ["beta"]).map((entry) => entry.name)).toEqual(["beta"]);
    expect(filterSkillEntries(entries, [])).toEqual([]);
    expect(filterSkillEntries(entries, undefined).map((entry) => entry.name)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("skips skills gated by metadata until env is present, unless always is true", () => {
    const workspace = mkdtempPath();
    mkdirSync(join(workspace, "skills"), { recursive: true });
    writeSkill(join(workspace, "skills"), "needs-env", {
      name: "needs-env",
      description: "Requires env.",
      metadata: { requires: { env: ["VULTURE_SKILL_TEST_KEY"] } },
    });
    writeSkill(join(workspace, "skills"), "always-env", {
      name: "always-env",
      description: "Always enabled.",
      metadata: { always: true, requires: { env: ["VULTURE_SKILL_TEST_KEY"] } },
    });

    try {
      const before = loadSkillEntries({ workspaceDir: workspace });
      expect(before.map((entry) => entry.name)).toEqual(["always-env"]);
      process.env.VULTURE_SKILL_TEST_KEY = "present";
      const after = loadSkillEntries({ workspaceDir: workspace });
      expect(after.map((entry) => entry.name)).toEqual(["always-env", "needs-env"]);
    } finally {
      delete process.env.VULTURE_SKILL_TEST_KEY;
      cleanup(workspace);
    }
  });

  test("skips symlinked and oversized skill files", () => {
    const workspace = mkdtempPath();
    const outside = mkdtempPath();
    mkdirSync(join(workspace, "skills", "linked"), { recursive: true });
    mkdirSync(join(workspace, "skills", "huge"), { recursive: true });
    writeSkill(outside, "escape", {
      name: "escape",
      description: "Escaped.",
    });
    symlinkSync(
      join(outside, "escape", "SKILL.md"),
      join(workspace, "skills", "linked", "SKILL.md"),
    );
    writeFileSync(
      join(workspace, "skills", "huge", "SKILL.md"),
      ["---", "name: huge", "description: Huge", "---", "x".repeat(64)].join("\n"),
    );

    try {
      const entries = loadSkillEntries({
        workspaceDir: workspace,
        maxSkillFileBytes: 32,
      });
      expect(entries).toEqual([]);
    } finally {
      cleanup(workspace);
      cleanup(outside);
    }
  });
});
