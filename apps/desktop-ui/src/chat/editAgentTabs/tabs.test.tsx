import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { CoreTab } from "./CoreTab";
import { OverviewTab } from "./OverviewTab";
import { ToolsTab } from "./ToolsTab";
import { draftFromAgent, type Draft } from "./draft";
import { localAgentFixture as baseAgent } from "../__fixtures__/agent";
import type { AgentCoreFile } from "../../api/agents";

describe("OverviewTab", () => {
  test("renders the primary identity fields and the workspace info block", () => {
    render(
      <OverviewTab
        agent={baseAgent}
        draft={draftFromAgent(baseAgent)}
        authStatus={null}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("名称")).toBeDefined();
    expect(screen.getByLabelText("模型")).toBeDefined();
    // Reasoning is a Segmented radiogroup; assert by role.
    expect(screen.getByRole("radiogroup", { name: "推理强度" })).toBeDefined();
    // Round 23: Skills moved to its own SkillsTab (rail item "技能").
    // The avatar picker landed in OverviewTab instead.
    expect(screen.getByRole("group", { name: "头像" })).toBeDefined();
    // Round 24: avatar picker grew categories (图标 / 字符 / 色块) and a
    // 重新生成 button so users can roll a fresh take without leaving.
    expect(screen.getByRole("radiogroup", { name: "头像分类" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "重新生成头像" }),
    ).toBeDefined();
    expect(screen.getByText("Workspace")).toBeDefined();
    expect(screen.getByText("/tmp/workspace")).toBeDefined();
  });

  test("editing the name calls onChange with a fresh draft", () => {
    const onChange = mock((_next: Draft) => {});
    render(
      <OverviewTab
        agent={baseAgent}
        draft={draftFromAgent(baseAgent)}
        authStatus={null}
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
        authStatus={null}
        onChange={onChange}
      />,
    );
    // Round 14: reasoning moved from <select> to a Segmented control;
    // click the "深度" (high) radio.
    fireEvent.click(screen.getByRole("radio", { name: "深度" }));
    const next = onChange.mock.calls[0]![0] as ReturnType<typeof draftFromAgent>;
    expect(next.reasoning).toBe("high");
  });

  test("model field renders a <select> when at least one option resolves", () => {
    // The current draft.model is preserved as a fallback option so an
    // existing agent's saved model never silently disappears from the
    // picker, even when no provider is configured (it shows up tagged
    // 未配置 under the provider that owns the model id).
    render(
      <OverviewTab
        agent={baseAgent}
        draft={{ ...draftFromAgent(baseAgent), model: "gpt-5.4" }}
        authStatus={null}
        onChange={() => {}}
      />,
    );
    const field = screen.getByLabelText("模型") as HTMLSelectElement;
    expect(field.tagName).toBe("SELECT");
    expect(field.value).toBe("gpt-5.4");
  });

  test("model field falls back to a free-form input when nothing resolves", () => {
    // No authStatus, no preserved model id → no options at all, so the
    // picker degrades to an unconstrained text input.
    render(
      <OverviewTab
        agent={null}
        draft={{ ...draftFromAgent(null), model: "" }}
        authStatus={null}
        onChange={() => {}}
      />,
    );
    const field = screen.getByLabelText("模型") as HTMLInputElement;
    expect(field.tagName).toBe("INPUT");
  });
});

describe("ToolsTab", () => {
  // Round 18: handoff surface moved to its own HandoffTab; ToolsTab now
  // only carries the preset + tool list + 清空/全选 affordances.
  const toolsTabBaseProps = {
    draft: draftFromAgent(baseAgent),
    toolGroups: [],
  };

  test("renders the preset selector + 全选 / 清空 buttons", () => {
    render(<ToolsTab {...toolsTabBaseProps} onChange={() => {}} />);
    // Round 14: preset moved from <select> to a Segmented radiogroup.
    expect(screen.getByRole("radiogroup", { name: "Tools 预设" })).toBeDefined();
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
    // Round 14: click the "最小" segment (value=minimal).
    fireEvent.click(screen.getByRole("radio", { name: "最小" }));
    const next = onChange.mock.calls[0]![0] as ReturnType<typeof draftFromAgent>;
    expect(next.toolPreset).toBe("minimal");
  });
});

describe("CoreTab", () => {
  const files: AgentCoreFile[] = [
    { name: "AGENTS.md", path: "/tmp/agents/agent-1/AGENTS.md", missing: false, size: 100 },
    { name: "memories.md", path: "/tmp/agents/agent-1/memories.md", missing: false, size: 50 },
  ];

  test("renders one tab per core file with aria-selected reflecting selection", () => {
    // Round 24: file rail moved from a flat button group to a
    // role=tab/tablist so screen readers announce file switching the
    // same way they announce the modal's outer rail.
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
    const a = screen.getByRole("tab", { name: /AGENTS\.md/, selected: true });
    const b = screen.getByRole("tab", { name: /memories\.md/, selected: false });
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
    fireEvent.click(screen.getByRole("tab", { name: /memories\.md/ }));
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
    const noSel = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
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
    const busy = screen.getByRole("button", { name: /保存中/ }) as HTMLButtonElement;
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

  test("AGENTS.md selection exposes the 风格 menu; memories.md does not", () => {
    // The persona starter picker is bound to the canonical persona file
    // so the user can't accidentally overwrite memories.md with a
    // role-prompt template.
    const { rerender } = render(
      <CoreTab
        files={files}
        selectedFile="AGENTS.md"
        onSelectFile={() => {}}
        fileContent=""
        onChangeFileContent={() => {}}
        fileBusy={false}
        fileStatus=""
        corePath="/tmp/agents/agent-1"
        onSave={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /风格/ })).toBeDefined();

    rerender(
      <CoreTab
        files={files}
        selectedFile="memories.md"
        onSelectFile={() => {}}
        fileContent=""
        onChangeFileContent={() => {}}
        fileBusy={false}
        fileStatus=""
        corePath="/tmp/agents/agent-1"
        onSave={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /风格/ })).toBeNull();
  });

  test("clicking a 风格 starter overwrites empty AGENTS.md without confirm", () => {
    const onChangeFileContent = mock((_n: string) => {});
    render(
      <CoreTab
        files={files}
        selectedFile="AGENTS.md"
        onSelectFile={() => {}}
        fileContent=""
        onChangeFileContent={onChangeFileContent}
        fileBusy={false}
        fileStatus=""
        corePath="/tmp/agents/agent-1"
        onSave={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /风格/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /通用助手/ }));
    expect(onChangeFileContent).toHaveBeenCalled();
    const seeded = onChangeFileContent.mock.calls[0]![0] as string;
    expect(seeded.length).toBeGreaterThan(0);
  });
});
