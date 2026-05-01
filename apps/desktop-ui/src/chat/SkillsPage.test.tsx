import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillsPage, type SkillsPageProps } from "./SkillsPage";
import type { SkillListItem, SkillListResponse } from "../api/skills";
import type { Agent } from "../api/agents";

const baseAgent: Agent = {
  id: "agent-1",
  name: "Local Agent",
  description: "",
  model: "gpt-5.4",
  reasoning: "medium",
  tools: [],
  workspace: {
    id: "agent-1",
    name: "Local Agent",
    path: "/tmp/workspace",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  },
  instructions: "",
  createdAt: "2026-04-28T00:00:00.000Z",
  updatedAt: "2026-04-28T00:00:00.000Z",
};

const skills: SkillListItem[] = [
  {
    name: "code-review",
    description: "Review pull requests and call out risks.",
    filePath: "/.skills/code-review.md",
    baseDir: "/.skills",
    source: "profile",
    modelInvocationEnabled: true,
    userInvocable: true,
    enabled: true,
  },
  {
    name: "summarize-doc",
    description: "Summarise long-form docs into bullet points.",
    filePath: "/.skills/summarize-doc.md",
    baseDir: "/.skills",
    source: "profile",
    modelInvocationEnabled: false,
    userInvocable: true,
    enabled: false,
  },
  {
    name: "workspace-test",
    description: "Workspace-local skill for project tests.",
    filePath: "/repo/.skills/workspace-test.md",
    baseDir: "/repo/.skills",
    source: "workspace",
    modelInvocationEnabled: true,
    userInvocable: true,
    enabled: true,
  },
];

function renderPage(overrides: Partial<SkillsPageProps> = {}) {
  const data: SkillListResponse = {
    agentId: "agent-1",
    policy: "allowlist",
    allowlist: ["code-review", "workspace-test"],
    items: skills,
  };
  const props: SkillsPageProps = {
    agents: [baseAgent],
    selectedAgentId: "agent-1",
    onSelectAgent: mock(() => undefined),
    onLoadSkills: mock(async () => data),
    onSaveAgentSkills: mock(async () => undefined),
    ...overrides,
  };
  return { props, ...render(<SkillsPage {...props} />) };
}

describe("SkillsPage", () => {
  test("exposes a source filter rail with per-source counts", async () => {
    const { container } = renderPage();
    // Marketplace layout (B2): source rail buttons, not group headings.
    // Scope the lookup to the rail itself — "全部启用"/"全部禁用"
    // policy buttons would otherwise collide with /^全部/.
    const rail = await waitFor(() => {
      const node = container.querySelector("[aria-label='技能来源']");
      if (!node) throw new Error("rail not yet rendered");
      return node as HTMLElement;
    });
    expect(rail.querySelector("button.skills-cat.active")).toBeTruthy();
    const buttons = Array.from(rail.querySelectorAll("button.skills-cat"));
    expect(buttons.length).toBe(3);
    const labels = buttons.map((b) => b.textContent ?? "");
    expect(labels.some((t) => /^全部/.test(t))).toBe(true);
    expect(labels.some((t) => /^Workspace.*1/.test(t))).toBe(true);
    expect(labels.some((t) => /^Profile.*2/.test(t))).toBe(true);
  });

  test("search filters skills by name and description", async () => {
    renderPage();
    await screen.findAllByText("code-review");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "summar" } });
    // Featured strip is hidden when a search is active, so the only
    // surface left is the grid card for the matching skill.
    expect(screen.getAllByText("summarize-doc").length).toBeGreaterThan(0);
    expect(screen.queryByText("code-review")).toBeNull();
    expect(screen.queryByText("workspace-test")).toBeNull();
  });

  test("each skill grid card shows a switch reflecting enabled state", async () => {
    renderPage();
    await screen.findAllByText("code-review");
    const switches = screen.getAllByRole("switch");
    // Three cards in the grid → three switches. Featured strip cards
    // are pure browse-buttons with no inline toggle.
    expect(switches.length).toBe(3);
    const codeReviewSwitch = switches.find((s) => s.getAttribute("aria-label")?.includes("code-review"));
    expect(codeReviewSwitch?.getAttribute("aria-checked")).toBe("true");
    const summariseSwitch = switches.find((s) => s.getAttribute("aria-label")?.includes("summarize-doc"));
    expect(summariseSwitch?.getAttribute("aria-checked")).toBe("false");
  });

  test("toggling a skill calls onSaveAgentSkills with the new allowlist", async () => {
    const onSaveAgentSkills = mock(async (_id: string, _skills: string[] | null) => {});
    renderPage({ onSaveAgentSkills });
    await screen.findAllByText("summarize-doc");

    const summariseSwitch = screen
      .getAllByRole("switch")
      .find((s) => s.getAttribute("aria-label")?.includes("summarize-doc"));
    expect(summariseSwitch).toBeDefined();
    fireEvent.click(summariseSwitch!);

    await waitFor(() => {
      expect(onSaveAgentSkills).toHaveBeenCalled();
    });
    const [, nextSkills] = onSaveAgentSkills.mock.calls[0]!;
    expect(nextSkills).toContain("summarize-doc");
    expect(nextSkills).toContain("code-review");
    expect(nextSkills).toContain("workspace-test");
  });

  test("shows a no-match message when search excludes everything", async () => {
    renderPage();
    await screen.findAllByText("code-review");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    expect(screen.getByText(/没有找到/)).toBeDefined();
  });
});
