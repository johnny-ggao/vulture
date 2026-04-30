import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { reduceRunEvents } from "./RunEventStream";
import { RunEventStream } from "./RunEventStream";
import type { AnyRunEvent } from "../hooks/useRunStream";

const ev = (overrides: Partial<AnyRunEvent>): AnyRunEvent => ({
  type: "text.delta",
  runId: "r",
  seq: 0,
  createdAt: "2026-04-27T00:00:00.000Z",
  ...overrides,
});

describe("reduceRunEvents", () => {
  test("text.delta concatenated into one assistant text block until tool/final", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "run.started", seq: 0, agentId: "a", model: "gpt-5.4" }),
      ev({ type: "text.delta", seq: 1, text: "Hello, " }),
      ev({ type: "text.delta", seq: 2, text: "world." }),
      ev({ type: "run.completed", seq: 3, resultMessageId: "m-x", finalText: "Hello, world." }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("text");
    if (blocks[0].kind === "text") expect(blocks[0].content).toBe("Hello, world.");
  });

  test("run.usage attaches token usage to the latest assistant text block", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "text.delta", seq: 1, text: "Hello" }),
      ev({
        type: "run.usage",
        seq: 2,
        usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks[0].kind).toBe("text");
    if (blocks[0].kind === "text") {
      expect(blocks[0].usage?.totalTokens).toBe(125);
    }
  });

  test("tool.planned -> tool block with running status when not yet completed", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "tool.planned", seq: 0, callId: "c1", tool: "shell.exec", input: { argv: ["ls"] } }),
      ev({ type: "tool.started", seq: 1, callId: "c1" }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("tool");
    if (blocks[0].kind === "tool") expect(blocks[0].status).toBe("running");
  });

  test("tool.completed flips status to completed with output", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "tool.planned", seq: 0, callId: "c1", tool: "shell.exec", input: {} }),
      ev({ type: "tool.completed", seq: 1, callId: "c1", output: { stdout: "ok" } }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks[0].kind).toBe("tool");
    if (blocks[0].kind === "tool") {
      expect(blocks[0].status).toBe("completed");
      expect(blocks[0].output).toEqual({ stdout: "ok" });
    }
  });

  test("tool.ask becomes an approval block", () => {
    const events: AnyRunEvent[] = [
      ev({
        type: "tool.ask",
        seq: 0,
        callId: "c1",
        tool: "shell.exec",
        reason: "outside workspace",
        approvalToken: "tok",
      }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks[0].kind).toBe("approval");
  });

  test("tool.started removes the matching approval block", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "tool.planned", seq: 0, callId: "c1", tool: "shell.exec", input: {} }),
      ev({
        type: "tool.ask",
        seq: 1,
        callId: "c1",
        tool: "shell.exec",
        reason: "outside workspace",
        approvalToken: "tok",
      }),
      ev({ type: "tool.started", seq: 2, callId: "c1" }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks.map((b) => b.kind)).toEqual(["tool"]);
    if (blocks[0].kind === "tool") expect(blocks[0].status).toBe("running");
  });

  test("tool.ask after tool.started renders as a new pending approval", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "tool.planned", seq: 0, callId: "c1", tool: "shell.exec", input: {} }),
      ev({
        type: "tool.ask",
        seq: 1,
        callId: "c1",
        tool: "shell.exec",
        reason: "outside workspace",
        approvalToken: "tok-1",
      }),
      ev({ type: "tool.started", seq: 2, callId: "c1" }),
      ev({
        type: "tool.ask",
        seq: 3,
        callId: "c1",
        tool: "shell.exec",
        reason: "still needs approval",
        approvalToken: "tok-2",
      }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks.map((b) => b.kind)).toEqual(["tool", "approval"]);
    if (blocks[1].kind === "approval") {
      expect(blocks[1].approvalToken).toBe("tok-2");
    }
  });

  test("text -> tool -> text -> final yields text+tool+text in order", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "text.delta", seq: 0, text: "before " }),
      ev({ type: "tool.planned", seq: 1, callId: "c1", tool: "shell.exec", input: {} }),
      ev({ type: "tool.completed", seq: 2, callId: "c1", output: {} }),
      ev({ type: "text.delta", seq: 3, text: "after" }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "tool", "text"]);
  });

  test("run.recoverable renders recovery block", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "text.delta", seq: 0, text: "before" }),
      ev({
        type: "run.recoverable",
        seq: 1,
        reason: "incomplete_tool",
        message: "Tool shell.exec may have been interrupted before completion.",
      }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "recovery"]);
    expect(blocks[1]).toMatchObject({
      kind: "recovery",
      message: "Tool shell.exec may have been interrupted before completion.",
      firstSeq: 1,
    });
  });

  test("run.recovered creates a boundary before later text", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "text.delta", seq: 0, text: "draft" }),
      ev({ type: "run.recovered", seq: 1, mode: "manual", discardPriorDraft: true }),
      ev({ type: "text.delta", seq: 2, text: " resumed" }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "recovery-boundary", "text"]);
    if (blocks[0].kind === "text") expect(blocks[0].content).toBe("draft");
    if (blocks[2].kind === "text") expect(blocks[2].content).toBe(" resumed");
  });

  test("run.recovered removes the pending recovery block", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "text.delta", seq: 0, text: "draft" }),
      ev({
        type: "run.recoverable",
        seq: 1,
        reason: "incomplete_tool",
        message: "Tool shell.exec may have been interrupted before completion.",
      }),
      ev({ type: "run.recovered", seq: 2, mode: "manual", discardPriorDraft: true }),
      ev({ type: "text.delta", seq: 3, text: "after" }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "recovery-boundary", "text"]);
  });

  test("run.failed renders a visible assistant error block", () => {
    const events: AnyRunEvent[] = [
      ev({
        type: "run.failed",
        seq: 1,
        error: { code: "internal", message: "Connection error." },
      }),
    ];

    const blocks = reduceRunEvents(events);
    expect(blocks).toEqual([
      {
        kind: "run-error",
        message: "Connection error.",
        code: "internal",
        firstSeq: 1,
      },
    ]);

    render(
      <RunEventStream
        events={events}
        submittingApprovals={new Set()}
        resuming={false}
        onDecide={() => {}}
        onResume={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/运行失败：Connection error\./)).toBeDefined();
  });

  // ---- Round 11: thinking indicator -------------------------------

  test("renders a thinking indicator while streaming with no text yet", () => {
    const { container } = render(
      <RunEventStream
        events={[]}
        submittingApprovals={new Set()}
        resuming={false}
        streaming
        onDecide={() => {}}
        onResume={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.querySelector(".thinking-dots")).not.toBeNull();
  });

  test("hides the thinking indicator once any text block has landed", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "text.delta", seq: 0, text: "Hi" }),
    ];
    const { container } = render(
      <RunEventStream
        events={events}
        submittingApprovals={new Set()}
        resuming={false}
        streaming
        onDecide={() => {}}
        onResume={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.querySelector(".thinking-dots")).toBeNull();
  });

  test("hides the thinking indicator when streaming is false", () => {
    const { container } = render(
      <RunEventStream
        events={[]}
        submittingApprovals={new Set()}
        resuming={false}
        streaming={false}
        onDecide={() => {}}
        onResume={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.querySelector(".thinking-dots")).toBeNull();
  });

  test("hides the thinking indicator while resuming (recovery flow owns the affordance)", () => {
    const { container } = render(
      <RunEventStream
        events={[]}
        submittingApprovals={new Set()}
        resuming
        streaming
        onDecide={() => {}}
        onResume={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.querySelector(".thinking-dots")).toBeNull();
  });

  test("thinking indicator still renders when only tool blocks (no text) are present", () => {
    const events: AnyRunEvent[] = [
      ev({
        type: "tool.planned",
        seq: 0,
        callId: "c1",
        tool: "shell.exec",
        input: { argv: ["ls"] },
      }),
    ];
    const { container } = render(
      <RunEventStream
        events={events}
        submittingApprovals={new Set()}
        resuming={false}
        streaming
        onDecide={() => {}}
        onResume={() => {}}
        onCancel={() => {}}
      />,
    );
    // Tool still renders, AND the thinking indicator is shown — the
    // user has zero textual response yet.
    expect(container.querySelector(".tool-block")).not.toBeNull();
    expect(container.querySelector(".thinking-dots")).not.toBeNull();
  });

  test("run.recovered renders a visible recovery boundary", () => {
    render(
      <RunEventStream
        events={[
          ev({ type: "text.delta", seq: 0, text: "draft" }),
          ev({ type: "run.recovered", seq: 1, mode: "manual", discardPriorDraft: true }),
          ev({ type: "text.delta", seq: 2, text: "after" }),
        ]}
        submittingApprovals={new Set()}
        resuming={false}
        onDecide={() => {}}
        onResume={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("separator").textContent).toBe("运行已恢复");
  });
});
