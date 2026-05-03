import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RunLogsPage, type RunLogsPageProps } from "./RunLogsPage";
import { localAgentFixture } from "./__fixtures__/agent";
import type { RunLogSummaryDto, RunTraceResponse } from "../api/runLogs";

const runSummary: RunLogSummaryDto = {
  conversationTitle: "Diagnostics",
  model: "gpt-5.4",
  eventCount: 4,
  toolCallCount: 1,
  approvalCount: 1,
  artifactCount: 1,
  subagentCount: 0,
  run: {
    id: "r-1",
    conversationId: "c-1",
    agentId: "local-work-agent",
    status: "succeeded",
    triggeredByMessageId: "m-user",
    resultMessageId: "m-assistant",
    startedAt: "2026-04-27T00:00:00.000Z",
    endedAt: "2026-04-27T00:00:01.000Z",
    error: null,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  },
};

const trace: RunTraceResponse = {
  run: runSummary.run,
  messages: [],
  events: [
    {
      type: "run.started",
      runId: "r-1",
      seq: 0,
      createdAt: "2026-04-27T00:00:00.000Z",
      agentId: "local-work-agent",
      model: "gpt-5.4",
    },
    {
      type: "text.delta",
      runId: "r-1",
      seq: 1,
      createdAt: "2026-04-27T00:00:00.050Z",
      text: "he",
    },
    {
      type: "text.delta",
      runId: "r-1",
      seq: 2,
      createdAt: "2026-04-27T00:00:00.060Z",
      text: "llo",
    },
    {
      type: "tool.planned",
      runId: "r-1",
      seq: 3,
      createdAt: "2026-04-27T00:00:00.100Z",
      callId: "call-1",
      tool: "fs.read",
      input: { path: "package.json" },
    },
    {
      type: "approval.review",
      runId: "r-1",
      seq: 4,
      createdAt: "2026-04-27T00:00:00.110Z",
      callId: "call-2",
      tool: "web_search",
      status: "approved",
      risk: "medium",
      reason: "Public network read.",
    },
  ],
  recovery: null,
  subagentSessions: [],
  artifacts: [],
};

function renderPage(overrides: Partial<RunLogsPageProps> = {}) {
  const props: RunLogsPageProps = {
    agents: [localAgentFixture],
    onListRunLogs: mock(async () => ({ items: [runSummary], nextOffset: null })),
    onLoadRunTrace: mock(async () => trace),
    ...overrides,
  };
  return { props, ...render(<RunLogsPage {...props} />) };
}

describe("RunLogsPage", () => {
  test("renders filters and refresh in a page toolbar", async () => {
    renderPage();

    expect(screen.getByRole("toolbar", { name: "运行日志筛选与刷新" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "状态" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "智能体" })).toBeDefined();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDefined();
    await screen.findByText("Diagnostics");
  });

  test("loads summaries without loading trace details until a row is opened", async () => {
    const onLoadRunTrace = mock(async () => trace);
    renderPage({ onLoadRunTrace });

    await screen.findByText("Diagnostics");
    expect(onLoadRunTrace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Diagnostics/ }));
    await screen.findByText("Timeline");
    expect(onLoadRunTrace).toHaveBeenCalledWith("r-1");
    expect(screen.getAllByText(/tool.planned/).length).toBeGreaterThan(0);
  });

  test("compacts text delta spam in the visible timeline", async () => {
    renderPage();
    await screen.findByText("Diagnostics");

    fireEvent.click(screen.getByRole("button", { name: /Diagnostics/ }));
    await screen.findByText("Timeline");

    expect(screen.getByText("text stream · 2 chunks · 5 chars")).toBeDefined();
    expect(screen.queryAllByText("text.delta")).toHaveLength(0);
  });

  test("labels automatic approval review events in the timeline", async () => {
    renderPage();
    await screen.findByText("Diagnostics");

    fireEvent.click(screen.getByRole("button", { name: /Diagnostics/ }));
    await screen.findByText("Timeline");

    expect(screen.getByText("approval.review · approved · medium · web_search")).toBeDefined();
  });

  test("sends filters to the summary loader", async () => {
    const onListRunLogs = mock(async () => ({ items: [runSummary], nextOffset: null }));
    renderPage({ onListRunLogs });
    await screen.findByText("Diagnostics");

    fireEvent.change(screen.getAllByDisplayValue("全部")[0], { target: { value: "failed" } });

    await waitFor(() => {
      expect(onListRunLogs).toHaveBeenLastCalledWith({
        status: "failed",
        agentId: undefined,
        limit: 50,
        offset: 0,
      });
    });
  });
});
