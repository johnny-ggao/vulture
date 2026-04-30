import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { NewAgentModal } from "./NewAgentModal";

const baseProps = {
  open: true,
  toolGroups: [],
  onClose: () => {},
  onCreate: async () => {},
};

/**
 * Walk the wizard from the template step through to the final step
 * (skills) by repeatedly clicking 继续. Tests that need to touch
 * later-step affordances use this helper to skip setup boilerplate.
 *
 * The wizard order is: template → identity → persona → tools → skills.
 * Identity needs a name typed before continuing.
 */
function advanceToStep(target: "identity" | "persona" | "tools" | "skills") {
  fireEvent.click(screen.getByRole("button", { name: "继续" })); // template → identity
  if (target === "identity") return;
  fireEvent.change(screen.getByPlaceholderText("例：周报助手"), {
    target: { value: "Test Agent" },
  });
  fireEvent.click(screen.getByRole("button", { name: "继续" })); // identity → persona
  if (target === "persona") return;
  fireEvent.click(screen.getByRole("button", { name: "继续" })); // persona → tools
  if (target === "tools") return;
  fireEvent.click(screen.getByRole("button", { name: "继续" })); // tools → skills
}

describe("NewAgentModal — round 16 alignment with edit modal", () => {
  test("identity step shows the reasoning Segmented (matches OverviewTab)", () => {
    render(<NewAgentModal {...baseProps} />);
    advanceToStep("identity");
    expect(screen.getByRole("radiogroup", { name: "推理强度" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "快速" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "标准" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "深度" })).toBeDefined();
  });

  test("persona step shows structural hint, counter, and starter chips when empty", () => {
    render(<NewAgentModal {...baseProps} />);
    advanceToStep("persona");
    // Hint visible.
    expect(screen.getByText(/角色 → 目标 → 行为边界/)).toBeDefined();
    // Starter chips appear because instructions is empty.
    expect(screen.getByRole("button", { name: "通用助手" })).toBeDefined();
    expect(screen.getByRole("button", { name: "代码审阅" })).toBeDefined();
    expect(screen.getByRole("button", { name: "写作助手" })).toBeDefined();
  });

  test("clicking a persona starter seeds the textarea and hides the chip row", () => {
    render(<NewAgentModal {...baseProps} />);
    advanceToStep("persona");
    fireEvent.click(screen.getByRole("button", { name: "通用助手" }));
    const ta = screen.getByLabelText("Instructions") as HTMLTextAreaElement;
    expect(ta.value).toContain("专业的助手");
    // Chip row gone.
    expect(screen.queryByText("从模板开始：")).toBeNull();
  });

  test("tools step shows the preset Segmented (matches ToolsTab)", () => {
    render(<NewAgentModal {...baseProps} />);
    advanceToStep("tools");
    expect(screen.getByRole("radiogroup", { name: "工具预设" })).toBeDefined();
    // The 6 preset segments are present.
    expect(screen.getByRole("radio", { name: "最小" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "标准" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "开发者" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "TL" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "全部" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "无" })).toBeDefined();
  });

  test("skills step shows the live tri-state preview", () => {
    const { container } = render(<NewAgentModal {...baseProps} />);
    advanceToStep("skills");
    // Default state pill — pick the SkillsStep's own preview by class
    // (the PreviewCard aside also shows a summary, hence the dupe).
    const defaultPill = container.querySelector(
      ".agent-skills-preview-default",
    );
    expect(defaultPill?.textContent).toBe("全部 Skills 可用");

    // Type "none" → 已禁用 pill.
    fireEvent.change(screen.getByLabelText("Skills"), {
      target: { value: "none" },
    });
    expect(
      container.querySelector(".agent-skills-preview-disabled")?.textContent,
    ).toBe("已禁用");

    // Type a list → chips.
    fireEvent.change(screen.getByLabelText("Skills"), {
      target: { value: "weather, search" },
    });
    const chips = Array.from(
      container.querySelectorAll(".agent-skills-chip"),
    ).map((n) => n.textContent);
    expect(chips).toEqual(["weather", "search"]);
  });

  test("close on a dirty wizard prompts before discarding work", () => {
    const originalConfirm = window.confirm;
    let confirmCalls = 0;
    (window as unknown as { confirm: () => boolean }).confirm = () => {
      confirmCalls += 1;
      return false;
    };
    const onClose = mock(() => {});
    try {
      render(<NewAgentModal {...baseProps} onClose={onClose} />);
      // Touch the name field — counts as "touched" for the dirty
      // signal even before continuing past the identity step.
      fireEvent.click(screen.getByRole("button", { name: "继续" }));
      fireEvent.change(screen.getByPlaceholderText("例：周报助手"), {
        target: { value: "WIP" },
      });
      // Click the X close button.
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      expect(confirmCalls).toBe(1);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("close on a clean wizard does NOT prompt and closes immediately", () => {
    const originalConfirm = window.confirm;
    let confirmCalls = 0;
    (window as unknown as { confirm: () => boolean }).confirm = () => {
      confirmCalls += 1;
      return true;
    };
    const onClose = mock(() => {});
    try {
      render(<NewAgentModal {...baseProps} onClose={onClose} />);
      // No edits, just close.
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      expect(confirmCalls).toBe(0);
      expect(onClose).toHaveBeenCalled();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("submit error surfaces an inline retry alert when onCreate throws", async () => {
    let calls = 0;
    const onCreate = async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
    };
    const { container } = render(
      <NewAgentModal {...baseProps} onCreate={onCreate} />,
    );
    advanceToStep("skills");
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await new Promise((r) => setTimeout(r, 0));
    const alert = container.querySelector(".agent-edit-error");
    expect(alert).not.toBeNull();
    expect(alert?.textContent ?? "").toContain("network down");

    // Retry → second onCreate call succeeds, alert closes.
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });

  test("submit error dismiss hides the alert without retrying", async () => {
    let calls = 0;
    const onCreate = async () => {
      calls += 1;
      throw new Error("boom");
    };
    const { container } = render(
      <NewAgentModal {...baseProps} onCreate={onCreate} />,
    );
    advanceToStep("skills");
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(".agent-edit-error")).not.toBeNull();
    fireEvent.click(
      container.querySelector(".agent-edit-error-dismiss") as HTMLButtonElement,
    );
    expect(container.querySelector(".agent-edit-error")).toBeNull();
    expect(calls).toBe(1); // no retry
  });
});
