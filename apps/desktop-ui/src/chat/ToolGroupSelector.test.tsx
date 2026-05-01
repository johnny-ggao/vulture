import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolGroupSelector } from "./ToolGroupSelector";
import type { ToolCatalogGroup } from "../api/tools";

const groups: ToolCatalogGroup[] = [
  {
    id: "files",
    label: "Files",
    description: "File operations",
    items: [
      { id: "read", label: "read", risk: "low", idempotent: true },
      { id: "write", label: "write", risk: "medium", idempotent: false },
    ],
  },
  {
    id: "web",
    label: "Web",
    description: "Web access",
    items: [
      { id: "web_search", label: "web_search", risk: "low", idempotent: true },
      { id: "web_fetch", label: "web_fetch", risk: "low", idempotent: true },
      { id: "web_extract", label: "web_extract", risk: "low", idempotent: true },
    ],
  },
  {
    id: "browser",
    label: "Browser",
    description: "Browser access",
    items: [
      { id: "browser.snapshot", label: "browser.snapshot", risk: "medium", idempotent: true },
      { id: "browser.click", label: "browser.click", risk: "medium", idempotent: false },
      { id: "browser.input", label: "browser.input", risk: "medium", idempotent: false },
      { id: "browser.scroll", label: "browser.scroll", risk: "medium", idempotent: false },
      { id: "browser.extract", label: "browser.extract", risk: "medium", idempotent: true },
    ],
  },
];

describe("ToolGroupSelector — round 17 filter", () => {
  test("renders the search input above capability tiles", () => {
    render(
      <ToolGroupSelector
        groups={groups}
        selected={[]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("搜索工具")).toBeDefined();
  });

  test("filtering by tool id narrows visible capabilities and groups", () => {
    const { container } = render(
      <ToolGroupSelector
        groups={groups}
        selected={[]}
        onChange={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("搜索工具"), {
      target: { value: "web" },
    });
    // Files capability tile is gone (no matching tool ids).
    expect(container.querySelector(".tool-capability-label")?.textContent).toBe(
      "Web",
    );
    expect(container.querySelectorAll(".tool-capability").length).toBe(1);
    // Count chip "matched / total" appears.
    expect(screen.getByText("3 / 10")).toBeDefined();
    // Detail expands automatically when filtering, so the matched
    // tools are visible without extra clicks.
    expect(container.querySelector(".tool-row")).not.toBeNull();
  });

  test("a query that matches nothing shows the empty hint", () => {
    render(
      <ToolGroupSelector
        groups={groups}
        selected={[]}
        onChange={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("搜索工具"), {
      target: { value: "no-such-tool" },
    });
    expect(screen.getByText("没有匹配的工具")).toBeDefined();
  });

  test("clearing the filter restores the full catalog", () => {
    const { container } = render(
      <ToolGroupSelector
        groups={groups}
        selected={[]}
        onChange={() => {}}
      />,
    );
    const input = screen.getByLabelText("搜索工具") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "web" } });
    expect(container.querySelectorAll(".tool-capability").length).toBe(1);
    fireEvent.change(input, { target: { value: "" } });
    // All capability tiles are present after clearing.
    expect(container.querySelectorAll(".tool-capability").length).toBe(3);
  });

  test("clicking a capability tile still calls onChange with the right tools", () => {
    const onChange = mock((_: string[]) => {});
    render(
      <ToolGroupSelector
        groups={groups}
        selected={[]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Web/ }));
    // Web capability covers search, raw fetch, and structured extract.
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0]![0];
    expect(next).toEqual(expect.arrayContaining(["web_search", "web_fetch", "web_extract"]));
  });

  test("browser capability covers snapshot, click, input, scroll, and extract", () => {
    const onChange = mock((_: string[]) => {});
    render(
      <ToolGroupSelector
        groups={groups}
        selected={[]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Browser/ }));

    const next = onChange.mock.calls[0]![0];
    expect(next).toEqual(
      expect.arrayContaining([
        "browser.snapshot",
        "browser.click",
        "browser.input",
        "browser.scroll",
        "browser.extract",
      ]),
    );
  });
});
