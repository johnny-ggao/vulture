import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { CoreTab } from "./CoreTab";
import { OverviewTab } from "./OverviewTab";
import { PersonaTab } from "./PersonaTab";
import { ToolsTab } from "./ToolsTab";
import { draftFromAgent, type Draft } from "./draft";
import { localAgentFixture as baseAgent } from "../__fixtures__/agent";
import type { AgentCoreFile } from "../../api/agents";

describe("OverviewTab", () => {
  test("renders all four primary fields and the workspace info block", () => {
    render(
      <OverviewTab
        agent={baseAgent}
        draft={draftFromAgent(baseAgent)}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("名称")).toBeDefined();
    expect(screen.getByLabelText("模型")).toBeDefined();
    expect(screen.getByLabelText("推理强度")).toBeDefined();
    expect(screen.getByLabelText("Skills")).toBeDefined();
    expect(screen.getByText("Workspace")).toBeDefined();
    expect(screen.getByText("/tmp/workspace")).toBeDefined();
  });

  test("editing the name calls onChange with a fresh draft", () => {
    const onChange = mock((_next: Draft) => {});
    render(
      <OverviewTab
        agent={baseAgent}
        draft={draftFromAgent(baseAgent)}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Renamed" },
    });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0]![0] as ReturnType<typeof draftFromAgent>;
    expect(next.name).toBe("Renamed");
  });

  test("changing reasoning calls onChange with the new level", () => {
    const onChange = mock((_next: Draft) => {});
    render(
      <OverviewTab
        agent={baseAgent}
        draft={draftFromAgent(baseAgent)}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("推理强度"), {
      target: { value: "high" },
    });
    const next = onChange.mock.calls[0]![0] as ReturnType<typeof draftFromAgent>;
    expect(next.reasoning).toBe("high");
  });
});

describe("PersonaTab", () => {
  test("editing instructions calls onChange with the new text", () => {
    const onChange = mock((_next: Draft) => {});
    render(
      <PersonaTab
        draft={draftFromAgent(baseAgent)}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "be thoughtful" },
    });
    const next = onChange.mock.calls[0]![0] as ReturnType<typeof draftFromAgent>;
    expect(next.instructions).toBe("be thoughtful");
  });
});

describe("ToolsTab", () => {
  // Shared minimal shape — most tests don't care about the handoff
  // surface, so an empty agents list keeps the body of the test focused
  // on the preset selector + 清空/全选 affordances.
  const toolsTabBaseProps = {
    draft: draftFromAgent(baseAgent),
    agentId: baseAgent.id,
    agents: [baseAgent] as ReadonlyArray<typeof baseAgent>,
    toolGroups: [],
  };

  test("renders the preset selector + 全选 / 清空 buttons", () => {
    render(<ToolsTab {...toolsTabBaseProps} onChange={() => {}} />);
    expect(screen.getByLabelText("Tools 预设")).toBeDefined();
    expect(screen.getByRole("button", { name: "全选" })).toBeDefined();
    expect(screen.getByRole("button", { name: "清空" })).toBeDefined();
  });

  test("clicking 清空 calls onChange with the 'none' policy", () => {
    const onChange = mock((_next: Draft) => {});
    render(<ToolsTab {...toolsTabBaseProps} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0]![0] as ReturnType<typeof draftFromAgent>;
    expect(next.toolPreset).toBe("none");
    expect(next.tools).toEqual([]);
  });

  test("changing the preset selector cascades into a new tools list", () => {
    const onChange = mock((_next: Draft) => {});
    render(<ToolsTab {...toolsTabBaseProps} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Tools 预设"), {
      target: { value: "minimal" },
    });
    const next = onChange.mock.calls[0]![0] as ReturnType<typeof draftFromAgent>;
    expect(next.toolPreset).toBe("minimal");
  });
});

describe("CoreTab", () => {
  const files: AgentCoreFile[] = [
    { name: "AGENTS.md", path: "/tmp/agents/agent-1/AGENTS.md", missing: false, size: 100 },
    { name: "memories.md", path: "/tmp/agents/agent-1/memories.md", missing: false, size: 50 },
  ];

  test("renders one file button per core file with aria-pressed reflecting selection", () => {
    render(
      <CoreTab
        files={files}
        selectedFile="AGENTS.md"
        onSelectFile={() => {}}
        fileContent="# hello"
        onChangeFileContent={() => {}}
        fileBusy={false}
        fileStatus=""
        corePath="/tmp/agents/agent-1"
        onSave={() => {}}
      />,
    );
    const a = screen.getByRole("button", { name: "AGENTS.md", pressed: true });
    const b = screen.getByRole("button", { name: "memories.md", pressed: false });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  test("clicking a file invokes onSelectFile with the file name", () => {
    const onSelectFile = mock((_n: string) => {});
    render(
      <CoreTab
        files={files}
        selectedFile="AGENTS.md"
        onSelectFile={onSelectFile}
        fileContent=""
        onChangeFileContent={() => {}}
        fileBusy={false}
        fileStatus=""
        corePath="/tmp/agents/agent-1"
        onSave={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "memories.md" }));
    expect(onSelectFile).toHaveBeenCalledWith("memories.md");
  });

  test("save button disabled when no file is selected OR fileBusy is true", () => {
    const { rerender } = render(
      <CoreTab
        files={files}
        selectedFile=""
        onSelectFile={() => {}}
        fileContent=""
        onChangeFileContent={() => {}}
        fileBusy={false}
        fileStatus=""
        corePath="/tmp/agents/agent-1"
        onSave={() => {}}
      />,
    );
    const noSel = screen.getByRole("button", { name: "保存文件" }) as HTMLButtonElement;
    expect(noSel.disabled).toBe(true);

    rerender(
      <CoreTab
        files={files}
        selectedFile="AGENTS.md"
        onSelectFile={() => {}}
        fileContent=""
        onChangeFileContent={() => {}}
        fileBusy={true}
        fileStatus=""
        corePath="/tmp/agents/agent-1"
        onSave={() => {}}
      />,
    );
    const busy = screen.getByRole("button", { name: "处理中..." }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
  });

  test("renders fileStatus when provided", () => {
    render(
      <CoreTab
        files={files}
        selectedFile="AGENTS.md"
        onSelectFile={() => {}}
        fileContent=""
        onChangeFileContent={() => {}}
        fileBusy={false}
        fileStatus="已保存"
        corePath="/tmp/agents/agent-1"
        onSave={() => {}}
      />,
    );
    expect(screen.getByText("已保存")).toBeDefined();
  });
});
