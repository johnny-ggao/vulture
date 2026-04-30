import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatAgentHeader, isRunningStatus } from "./ChatAgentHeader";
import type { RunStreamStatus } from "../hooks/useRunStream";

const baseAgent = { id: "agent-1", name: "Robin" };

describe("isRunningStatus", () => {
  test("returns true whenever resuming is true, regardless of status", () => {
    const terminal: RunStreamStatus[] = [
      "idle",
      "succeeded",
      "failed",
      "cancelled",
    ];
    for (const status of terminal) {
      expect(isRunningStatus(status, true)).toBe(true);
    }
  });

  test("treats every active phase as running", () => {
    const active: RunStreamStatus[] = [
      "connecting",
      "streaming",
      "reconnecting",
      "recoverable",
    ];
    for (const status of active) {
      expect(isRunningStatus(status, false)).toBe(true);
    }
  });

  test("treats every quiescent phase as NOT running", () => {
    const terminal: RunStreamStatus[] = [
      "idle",
      "succeeded",
      "failed",
      "cancelled",
    ];
    for (const status of terminal) {
      expect(isRunningStatus(status, false)).toBe(false);
    }
  });
});

describe("ChatAgentHeader", () => {
  test("renders the agent name", () => {
    render(
      <ChatAgentHeader agent={baseAgent} runStatus="idle" resuming={false} />,
    );
    expect(screen.getByText("Robin")).toBeDefined();
  });

  test("hides the status pill when the run is quiescent and not resuming", () => {
    const { container } = render(
      <ChatAgentHeader agent={baseAgent} runStatus="idle" resuming={false} />,
    );
    expect(container.querySelector(".chat-agent-status")).toBeNull();
  });

  test("shows '回应中' while streaming", () => {
    render(
      <ChatAgentHeader
        agent={baseAgent}
        runStatus="streaming"
        resuming={false}
      />,
    );
    expect(screen.getByText("回应中")).toBeDefined();
  });

  test("shows '连接中' while connecting", () => {
    render(
      <ChatAgentHeader
        agent={baseAgent}
        runStatus="connecting"
        resuming={false}
      />,
    );
    expect(screen.getByText("连接中")).toBeDefined();
  });

  test("shows '重连中' while reconnecting", () => {
    render(
      <ChatAgentHeader
        agent={baseAgent}
        runStatus="reconnecting"
        resuming={false}
      />,
    );
    expect(screen.getByText("重连中")).toBeDefined();
  });

  test("shows '等待恢复' on recoverable", () => {
    render(
      <ChatAgentHeader
        agent={baseAgent}
        runStatus="recoverable"
        resuming={false}
      />,
    );
    expect(screen.getByText("等待恢复")).toBeDefined();
  });

  test("resuming=true wins over a quiescent status (shows '恢复中')", () => {
    render(
      <ChatAgentHeader agent={baseAgent} runStatus="idle" resuming={true} />,
    );
    expect(screen.getByText("恢复中")).toBeDefined();
  });

  test("status pill carries aria-live=polite for assistive tech", () => {
    const { container } = render(
      <ChatAgentHeader
        agent={baseAgent}
        runStatus="streaming"
        resuming={false}
      />,
    );
    const pill = container.querySelector(".chat-agent-status");
    expect(pill?.getAttribute("aria-live")).toBe("polite");
  });

  test("cursor gloss writes --mouse-x / --mouse-y after mouseenter + move", () => {
    const { container } = render(
      <ChatAgentHeader
        agent={baseAgent}
        runStatus="streaming"
        resuming={false}
      />,
    );
    const root = container.querySelector(".chat-agent-header") as HTMLElement;
    expect(root).toBeDefined();
    fireEvent.mouseEnter(root);
    fireEvent.mouseMove(root, { clientX: 50, clientY: 25 });
    expect(root.style.getPropertyValue("--mouse-x")).not.toBe("");
    expect(root.style.getPropertyValue("--mouse-y")).not.toBe("");
  });
});
