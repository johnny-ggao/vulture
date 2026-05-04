import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react/pure";
import type { Agent } from "../api/agents";
import type { ArtifactEntryDto } from "../api/artifacts";
import { ArtifactsPage } from "./ArtifactsPage";

const agent: Agent = {
  id: "vulture",
  name: "Vulture",
  description: "",
  model: "openai/gpt-5.4",
  reasoning: "medium",
  tools: [],
  toolPreset: "developer",
  toolInclude: [],
  toolExclude: [],
  handoffAgentIds: [],
  workspace: {
    id: "vulture",
    name: "Vulture",
    path: "/tmp/vulture",
    createdAt: "2026-05-03T10:00:00.000Z",
    updatedAt: "2026-05-03T10:00:00.000Z",
  },
  instructions: "",
  createdAt: "2026-05-03T10:00:00.000Z",
  updatedAt: "2026-05-03T10:00:00.000Z",
};

const artifacts: ArtifactEntryDto[] = [
  {
    id: "artifact-text",
    runId: "r-91ee62aa-4709-4f6a-925d-e4c55091e05b",
    conversationId: "c-e7ffc3",
    agentId: "vulture",
    kind: "text",
    title: "run:r-91ee62aa:final",
    mimeType: "text/plain",
    content: "我查了当前工作区，结论是现在没有可审查的最近代码改动。",
    path: null,
    url: null,
    metadata: { source: "final" },
    createdAt: "2026-05-03T10:34:36.000Z",
  },
  {
    id: "artifact-data",
    runId: "r-91ee62aa",
    conversationId: "c-e7ffc3",
    agentId: "vulture",
    kind: "data",
    title: "update_plan:call",
    mimeType: "application/json",
    content: JSON.stringify({ items: [{ step: "查看仓库状态", status: "completed" }] }),
    path: null,
    url: null,
    metadata: {},
    createdAt: "2026-05-03T10:34:27.000Z",
  },
];

describe("ArtifactsPage", () => {
  test("renders dense artifact browser structure and filters by kind", async () => {
    render(
      <ArtifactsPage
        agents={[agent]}
        selectedAgentId="vulture"
        onListArtifacts={mock(async () => ({ items: artifacts }))}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("最近产物")).toBeDefined();
    });

    expect(screen.getByText("文本 1 · 数据 1 · 文件 0 · 链接 0")).toBeDefined();
    expect(screen.getByText("内容预览")).toBeDefined();
    expect(screen.getByText("元数据")).toBeDefined();

    fireEvent.change(screen.getByRole("combobox", { name: "类型" }), {
      target: { value: "data" },
    });

    expect(screen.getByText("匹配 / 2 总计")).toBeDefined();
    expect(screen.getAllByText("update_plan:call").length).toBeGreaterThan(0);
    expect(screen.queryByText("run:r-91ee62aa:final")).toBeNull();
  });
});
