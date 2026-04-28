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

  test("agent select calls onSelectAgent", () => {
    const onSelectAgent = mock(() => {});
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
    const select = screen.getByDisplayValue("Agent One") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "a2" } });
    expect(onSelectAgent).toHaveBeenCalledWith("a2");
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
});
