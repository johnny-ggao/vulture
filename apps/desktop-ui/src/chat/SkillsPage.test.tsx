import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillsPage, type SkillsPageProps } from "./SkillsPage";
import type { SkillCatalogEntry, SkillListItem, SkillListResponse } from "../api/skills";

const skills: SkillListItem[] = [
  {
    name: "code-review",
    description: "Review pull requests and call out risks.",
    filePath: "/.skills/code-review.md",
    baseDir: "/.skills",
    source: "profile",
    modelInvocationEnabled: true,
    userInvocable: true,
  },
  {
    name: "summarize-doc",
    description: "Summarise long-form docs into bullet points.",
    filePath: "/.skills/summarize-doc.md",
    baseDir: "/.skills",
    source: "profile",
    modelInvocationEnabled: false,
    userInvocable: true,
  },
];

const catalog: SkillCatalogEntry[] = [
  {
    name: "csv-insights",
    description: "Analyze CSV files.",
    version: "1.2.0",
    source: "local",
    packagePath: "/packages/csv-insights",
    installed: true,
    installedVersion: "1.0.0",
    installedAt: "2026-05-01T00:00:00.000Z",
    needsUpdate: true,
    lifecycleStatus: "outdated",
    lastError: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  },
  {
    name: "broken-skill",
    description: "A package that failed to install.",
    version: "0.1.0",
    source: "manual",
    installed: false,
    installedVersion: null,
    installedAt: null,
    needsUpdate: false,
    lifecycleStatus: "failed",
    lastError: "SKILL.md not found",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  },
];

function renderPage(overrides: Partial<SkillsPageProps> = {}) {
  const data: SkillListResponse = { items: skills };
  const props: SkillsPageProps = {
    onLoadSkills: mock(async () => data),
    onLoadSkillCatalog: mock(async () => ({ items: catalog })),
    onImportSkillPackage: mock(async (_packagePath: string) => catalog[0]!),
    onInstallSkill: mock(async (_name: string) => catalog[0]!),
    onUpdateSkillCatalog: mock(async () => ({ items: catalog })),
    ...overrides,
  };
  return { props, ...render(<SkillsPage {...props} />) };
}

describe("SkillsPage", () => {
  test("does not expose agent-specific skill controls", async () => {
    renderPage();
    await screen.findAllByText("code-review");

    expect(screen.queryByLabelText("选择智能体")).toBeNull();
    expect(screen.queryByLabelText("批量启用策略")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  test("does not render a per-source filter rail (skills are global)", async () => {
    const { container } = renderPage();
    await screen.findAllByText("code-review");
    expect(container.querySelector("[aria-label='技能来源']")).toBeNull();
  });

  test("keeps the skill browser ahead of catalog management", async () => {
    const { container } = renderPage();
    await screen.findAllByText("code-review");
    const skillsGrid = container.querySelector(".skills-grid");
    const catalogPanel = container.querySelector(".skill-catalog-panel");
    expect(skillsGrid).toBeTruthy();
    expect(catalogPanel).toBeTruthy();
    expect(
      Boolean(
        skillsGrid?.compareDocumentPosition(catalogPanel!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  test("search filters skills by name and description", async () => {
    renderPage();
    await screen.findAllByText("code-review");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "summar" } });
    // Featured strip is hidden when a search is active, so the only
    // surface left is the grid card for the matching skill.
    expect(screen.getAllByText("summarize-doc").length).toBeGreaterThan(0);
    expect(screen.queryByText("code-review")).toBeNull();
  });

  test("shows a no-match message when search excludes everything", async () => {
    renderPage();
    await screen.findAllByText("code-review");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    expect(screen.getByText(/没有找到/)).toBeDefined();
  });

  test("shows catalog lifecycle status and can install outdated skills", async () => {
    const onInstallSkill = mock(async (_name: string) => ({
      ...catalog[0]!,
      installedVersion: "1.2.0",
      needsUpdate: false,
      lifecycleStatus: "installed" as const,
    }));
    renderPage({ onInstallSkill });

    await screen.findByText("Skill Catalog");
    expect(screen.getByText("csv-insights")).toBeDefined();
    expect(screen.getByText("1.0.0 → 1.2.0")).toBeDefined();
    expect(screen.getByText("SKILL.md not found")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "更新 csv-insights" }));
    await waitFor(() => {
      expect(onInstallSkill).toHaveBeenCalledWith("csv-insights");
    });
  });

  test("imports a local skill package into the catalog", async () => {
    const onImportSkillPackage = mock(async (_packagePath: string) => catalog[0]!);
    renderPage({ onImportSkillPackage });

    await screen.findByText("Skill Catalog");
    fireEvent.change(screen.getByLabelText("Skill package path"), {
      target: { value: "/packages/csv-insights" },
    });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));

    await waitFor(() => {
      expect(onImportSkillPackage).toHaveBeenCalledWith("/packages/csv-insights");
    });
  });
});
