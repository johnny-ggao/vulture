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
});
