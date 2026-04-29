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
  test("groups skills by source with counts", async () => {
    renderPage();
    // Scope to headings: skill names (e.g., "workspace-test") and descriptions
    // (e.g., "Workspace-local…") would otherwise also match /^workspace/i.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /^profile/i })).toBeDefined();
      expect(screen.getByRole("heading", { name: /^workspace/i })).toBeDefined();
    });
    // 2 profile skills + 1 workspace skill — counts shown in headings
    expect(screen.getByRole("heading", { name: /profile.*\(2\)/i })).toBeDefined();
    expect(screen.getByRole("heading", { name: /workspace.*\(1\)/i })).toBeDefined();
  });

  test("search filters skills by name and description", async () => {
    renderPage();
    await screen.findByText("code-review");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "summar" } });
    expect(screen.getByText("summarize-doc")).toBeDefined();
    expect(screen.queryByText("code-review")).toBeNull();
    expect(screen.queryByText("workspace-test")).toBeNull();
  });

  test("each skill row shows a switch reflecting enabled state", async () => {
    renderPage();
    await screen.findByText("code-review");
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBe(3);
    const codeReviewSwitch = switches.find((s) => s.getAttribute("aria-label")?.includes("code-review"));
    expect(codeReviewSwitch?.getAttribute("aria-checked")).toBe("true");
    const summariseSwitch = switches.find((s) => s.getAttribute("aria-label")?.includes("summarize-doc"));
    expect(summariseSwitch?.getAttribute("aria-checked")).toBe("false");
  });

  test("toggling a skill calls onSaveAgentSkills with the new allowlist", async () => {
    const onSaveAgentSkills = mock(async (_id: string, _skills: string[] | null) => {});
    renderPage({ onSaveAgentSkills });
    await screen.findByText("summarize-doc");

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
    await screen.findByText("code-review");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    expect(screen.getByText(/没有找到/)).toBeDefined();
  });
});
