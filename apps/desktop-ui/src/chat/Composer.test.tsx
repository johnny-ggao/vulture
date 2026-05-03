import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";

describe("Composer", () => {
  test("Enter sends; Shift+Enter does not", () => {
    const onSend = mock(() => {});
    const onCancel = mock(() => {});
    render(
      <Composer
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

  test("IME composition Enter does not send", () => {
    const onSend = mock(() => {});
    render(
      <Composer
        running={false}
        onSend={onSend}
        onCancel={() => {}}
      />,
    );
    const ta = screen.getByPlaceholderText(/输入问题/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "中文输入" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false, isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe("中文输入");
  });

  test("attaches selected files when sending", async () => {
    const onSend = mock(() => {});
    render(
      <Composer
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
        running={true}
        onSend={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByLabelText("取消"));
    expect(onCancel).toHaveBeenCalled();
  });

  test("Meta+. and Ctrl+. cancel a running response", () => {
    const onCancel = mock(() => {});
    render(
      <Composer
        running={true}
        onSend={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    fireEvent.keyDown(window, { key: ".", ctrlKey: true });
    fireEvent.keyDown(window, { key: ".", metaKey: true, shiftKey: true });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });


  test("thinking-mode chip popover surfaces all three options after click", () => {
    render(
      <Composer
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    // Closed by default — only the trigger is visible.
    fireEvent.click(screen.getByRole("button", { name: /思考模式/ }));
    expect(screen.getByRole("menuitemradio", { name: /快速/ })).toBeDefined();
    expect(screen.getByRole("menuitemradio", { name: /标准/ })).toBeDefined();
    expect(screen.getByRole("menuitemradio", { name: /深度/ })).toBeDefined();
  });

  test("permission-mode chip popover notifies changes through menu items", () => {
    const onChangePermissionMode = mock(
      (_mode: "default" | "read_only" | "auto_review" | "full_access") => {},
    );
    render(
      <Composer
        permissionMode="default"
        onChangePermissionMode={onChangePermissionMode}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );

    // Trigger label reflects current selection.
    expect(screen.getByRole("button", { name: /工具权限.*默认权限/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /工具权限/ }));
    expect(
      screen.getByRole("menuitemradio", { name: /默认权限/ }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /智能审批/ }));
    expect(onChangePermissionMode).toHaveBeenCalledWith("auto_review");
    // Re-open and pick again — the popover closes after a selection.
    fireEvent.click(screen.getByRole("button", { name: /工具权限/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /整机完全权限/ }));
    expect(onChangePermissionMode).toHaveBeenCalledWith("full_access");
  });

  test("thinking-mode chip defaults to 快速 with aria-checked on the menu item", () => {
    render(
      <Composer
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /思考模式/ }));
    const fast = screen.getByRole("menuitemradio", { name: /快速/ });
    expect(fast.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: /标准/ }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen.getByRole("menuitemradio", { name: /深度/ }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("clicking a thinking-mode menu item moves the aria-checked state", () => {
    render(
      <Composer
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /思考模式/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /深度/ }));
    // Re-open to inspect new state.
    fireEvent.click(screen.getByRole("button", { name: /思考模式/ }));
    expect(
      screen.getByRole("menuitemradio", { name: /快速/ }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen.getByRole("menuitemradio", { name: /深度/ }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  // ---- Round 10: attachment chips, dedupe, drag-drop --------------

  test("attachment chip shows file name + a tabular size + remove button", () => {
    render(
      <Composer
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
