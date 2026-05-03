import { describe, expect, test, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { CodingAgentBanner } from "./CodingAgentBanner";

describe("CodingAgentBanner", () => {
  test("renders the workspace nudge copy", () => {
    render(<CodingAgentBanner agentId="coding-agent" onOpenAgentEdit={() => {}} />);
    expect(screen.getByText(/隔离工作区|workspace/i)).toBeTruthy();
  });

  test("clicking the action invokes onOpenAgentEdit with the agent id", () => {
    const onOpen = mock(() => {});
    render(<CodingAgentBanner agentId="coding-agent" onOpenAgentEdit={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /切换|edit|change/i }));
    expect(onOpen).toHaveBeenCalledWith("coding-agent");
  });

  test("dismiss button hides the banner", () => {
    render(<CodingAgentBanner agentId="coding-agent" onOpenAgentEdit={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss|关闭|×/i }));
    expect(screen.queryByText(/隔离工作区/i)).toBeNull();
  });
});
