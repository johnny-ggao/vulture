import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";

const agents = [
  { id: "a1", name: "Agent One" },
  { id: "a2", name: "Agent Two" },
];

describe("Composer", () => {
  test("Enter sends; Shift+Enter does not", () => {
    const onSend = mock(() => {});
    const onCancel = mock(() => {});
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={onSend}
        onCancel={onCancel}
      />,
    );
    const ta = screen.getByPlaceholderText(/输入问题/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("hello", []);

    fireEvent.change(ta, { target: { value: "next" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test("attaches selected files when sending", async () => {
    const onSend = mock(() => {});
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={onSend}
        onCancel={() => {}}
      />,
    );
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("添加附件"), {
      target: { files: [file] },
    });
    fireEvent.change(screen.getByPlaceholderText(/输入问题/), {
      target: { value: "read this" },
    });
    fireEvent.click(screen.getByLabelText("发送"));

    expect(onSend).toHaveBeenCalledWith("read this", [file]);
    await waitFor(() => {
      expect(screen.queryByText("note.txt")).toBeNull();
    });
  });

  test("keeps draft and attachments when send reports failure", async () => {
    const onSend = mock(async () => false);
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={onSend}
        onCancel={() => {}}
      />,
    );
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("添加附件"), {
      target: { files: [file] },
    });
    const ta = screen.getByPlaceholderText(/输入问题/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "read this" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalled();
    });
    expect(ta.value).toBe("read this");
    expect(screen.getByText("note.txt")).toBeDefined();
  });

  test("running shows ⏹ cancel button", () => {
    const onCancel = mock(() => {});
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={true}
        onSend={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByLabelText("取消"));
    expect(onCancel).toHaveBeenCalled();
  });

  test("agent picker shows current agent name", () => {
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: /智能体/ });
    expect(trigger.textContent).toContain("Agent One");
  });

  test("clicking the agent picker opens a menu listing all agents", () => {
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /智能体/ }));
    expect(screen.getByRole("menu", { name: /智能体/ })).toBeDefined();
    expect(screen.getByRole("menuitemradio", { name: /Agent One/ })).toBeDefined();
    expect(screen.getByRole("menuitemradio", { name: /Agent Two/ })).toBeDefined();
  });

  test("selecting an agent from the menu calls onSelectAgent and closes the menu", () => {
    const onSelectAgent = mock((_id: string) => {});
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={onSelectAgent}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /智能体/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Agent Two/ }));
    expect(onSelectAgent).toHaveBeenCalledWith("a2");
    expect(screen.queryByRole("menu", { name: /智能体/ })).toBeNull();
  });

  test("ArrowDown / ArrowUp / Home / End navigate the agent picker", () => {
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /智能体/ }));
    const menu = screen.getByRole("menu", { name: /智能体/ });
    const items = screen.getAllByRole("menuitemradio");
    // Initially the active item (Agent One) gets focus + tabIndex=0
    expect(items[0].getAttribute("tabindex")).toBe("0");
    expect(items[1].getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[0].getAttribute("tabindex")).toBe("-1");
    expect(items[1].getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(menu, { key: "End" });
    expect(items[items.length - 1].getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(menu, { key: "Home" });
    expect(items[0].getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    // Wraps to last
    expect(items[items.length - 1].getAttribute("tabindex")).toBe("0");
  });

  test("Escape closes the agent picker without selecting", () => {
    const onSelectAgent = mock((_id: string) => {});
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={onSelectAgent}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /智能体/ }));
    expect(screen.getByRole("menu", { name: /智能体/ })).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: /智能体/ })).toBeNull();
    expect(onSelectAgent).not.toHaveBeenCalled();
  });

  test("empty input does not send on Enter", () => {
    const onSend = mock(() => {});
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={onSend}
        onCancel={() => {}}
      />,
    );
    const ta = screen.getByPlaceholderText(/输入问题/) as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("does not clear draft when no agent is selected", () => {
    const onSend = mock(() => {});
    render(
      <Composer
        agents={[]}
        selectedAgentId=""
        onSelectAgent={() => {}}
        running={false}
        onSend={onSend}
        onCancel={() => {}}
      />,
    );
    const ta = screen.getByPlaceholderText(/输入问题/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello after switch" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe("hello after switch");
  });

  test("thinking-mode segmented control shows all three options at once", () => {
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("radio", { name: "快速" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "标准" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "深度" })).toBeDefined();
  });

  test("permission-mode segmented control notifies changes", () => {
    const onChangePermissionMode = mock(
      (_mode: "default" | "read_only" | "auto_review" | "full_access") => {},
    );
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        permissionMode="default"
        onChangePermissionMode={onChangePermissionMode}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole("radio", { name: "默认权限" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "智能审批" }));
    expect(onChangePermissionMode).toHaveBeenCalledWith("auto_review");
    fireEvent.click(screen.getByRole("radio", { name: "整机完全权限" }));
    expect(onChangePermissionMode).toHaveBeenCalledWith("full_access");
  });

  test("thinking-mode default is 快速 with aria-checked=true", () => {
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    const fast = screen.getByRole("radio", { name: "快速" });
    expect(fast.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "标准" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: "深度" }).getAttribute("aria-checked")).toBe("false");
  });

  test("clicking a thinking-mode option moves the aria-checked state", () => {
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "深度" }));
    expect(screen.getByRole("radio", { name: "快速" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: "深度" }).getAttribute("aria-checked")).toBe("true");
  });

  // ---- Round 10: attachment chips, dedupe, drag-drop --------------

  test("attachment chip shows file name + a tabular size + remove button", () => {
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    const file = new File(["abcde"], "note.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("添加附件"), {
      target: { files: [file] },
    });
    expect(screen.getByText("note.txt")).toBeDefined();
    // 5 bytes → "5 B" rendered in a tabular-numeric pill.
    expect(screen.getByText("5 B")).toBeDefined();
    expect(screen.getByLabelText(/移除 note.txt/)).toBeDefined();
  });

  test("clicking the remove button drops that file from the staged list", () => {
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    const file = new File(["x"], "note.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("添加附件"), {
      target: { files: [file] },
    });
    expect(screen.getByText("note.txt")).toBeDefined();
    fireEvent.click(screen.getByLabelText(/移除 note.txt/));
    expect(screen.queryByText("note.txt")).toBeNull();
  });

  test("dropping files onto the composer attaches them", () => {
    const { container } = render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    const composer = container.querySelector(".composer") as HTMLElement;
    const file = new File(["x"], "drop.txt", { type: "text/plain" });
    const dataTransfer = {
      types: ["Files"],
      files: [file],
    };
    fireEvent.drop(composer, { dataTransfer });
    expect(screen.getByText("drop.txt")).toBeDefined();
  });

  test("dragenter toggles a dragging class so the drop overlay can show", () => {
    const { container } = render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    const composer = container.querySelector(".composer") as HTMLElement;
    fireEvent.dragEnter(composer, { dataTransfer: { types: ["Files"] } });
    expect(composer.classList.contains("composer-dragging")).toBe(true);
    fireEvent.dragLeave(composer, { dataTransfer: { types: ["Files"] } });
    expect(composer.classList.contains("composer-dragging")).toBe(false);
  });

  test("does NOT enter drag state for non-file drags (text selection etc.)", () => {
    const { container } = render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    const composer = container.querySelector(".composer") as HTMLElement;
    fireEvent.dragEnter(composer, { dataTransfer: { types: ["text/plain"] } });
    expect(composer.classList.contains("composer-dragging")).toBe(false);
  });

  test("attaching the same file twice de-dupes by (name, size)", () => {
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    const dup = new File(["abc"], "same.txt", { type: "text/plain" });
    const input = screen.getByLabelText("添加附件");
    fireEvent.change(input, { target: { files: [dup] } });
    fireEvent.change(input, { target: { files: [dup] } });
    // Only one chip in the DOM despite picking the file twice.
    const chips = document.querySelectorAll(".composer-attachment");
    expect(chips.length).toBe(1);
  });
});
