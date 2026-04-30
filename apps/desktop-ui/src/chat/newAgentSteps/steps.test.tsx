import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  IdentityStep,
  PersonaStep,
  SkillsStep,
  STEPS,
  StepRail,
  TemplateStep,
  TEMPLATES,
  ToolsStep,
  type WizardStep,
} from "./index";
import { toolPolicyFromPreset } from "../../api/tools";

describe("STEPS metadata", () => {
  test("ordered template → identity → persona → tools → skills", () => {
    expect(STEPS.map((s) => s.id)).toEqual([
      "template",
      "identity",
      "persona",
      "tools",
      "skills",
    ]);
  });

  test("every step carries a non-empty label and desc", () => {
    for (const step of STEPS) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.desc.length).toBeGreaterThan(0);
    }
  });
});

describe("StepRail", () => {
  function renderRail(opts?: {
    step?: WizardStep;
    onSelect?: (id: WizardStep) => void;
    isReachable?: (id: WizardStep, index: number) => boolean;
  }) {
    const onSelect = opts?.onSelect ?? mock((_: WizardStep) => {});
    const isReachable = opts?.isReachable ?? (() => true);
    render(
      <StepRail
        step={opts?.step ?? "template"}
        onSelect={onSelect}
        isReachable={isReachable}
      />,
    );
    return { onSelect };
  }

  test("renders one button per STEP entry", () => {
    renderRail();
    for (const step of STEPS) {
      expect(screen.getByText(step.label)).toBeDefined();
    }
  });

  test("active step gets the .active class; earlier steps get .complete", () => {
    renderRail({ step: "tools" });
    // tools is active; template/identity/persona are complete; skills is pending
    const railRoot = screen.getByLabelText("创建步骤");
    const buttons = railRoot.querySelectorAll("button");
    // index 0 (template), 1 (identity), 2 (persona) → complete
    expect(buttons[0]!.className).toContain("complete");
    expect(buttons[1]!.className).toContain("complete");
    expect(buttons[2]!.className).toContain("complete");
    // index 3 (tools) → active
    expect(buttons[3]!.className).toContain("active");
    // index 4 (skills) → neither
    expect(buttons[4]!.className).not.toContain("active");
    expect(buttons[4]!.className).not.toContain("complete");
  });

  test("clicking a reachable step calls onSelect with that step id", () => {
    const onSelect = mock((_: WizardStep) => {});
    renderRail({ onSelect });
    fireEvent.click(screen.getByText("Persona"));
    expect(onSelect).toHaveBeenCalledWith("persona");
  });

  test("clicking an unreachable step does NOT call onSelect", () => {
    const onSelect = mock((_: WizardStep) => {});
    renderRail({
      onSelect,
      // template + identity reachable, others not
      isReachable: (_id, index) => index <= 1,
    });
    fireEvent.click(screen.getByText("Skills"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("TemplateStep", () => {
  test("renders one button per template", () => {
    render(<TemplateStep selected="blank" onSelect={() => {}} />);
    for (const tpl of TEMPLATES) {
      expect(screen.getByText(tpl.label)).toBeDefined();
    }
  });

  test("selected template gets the .selected class", () => {
    render(<TemplateStep selected="writer" onSelect={() => {}} />);
    const writerBtn = screen.getByText("写作助手").closest("button")!;
    expect(writerBtn.className).toContain("selected");
    const blankBtn = screen.getByText("空白").closest("button")!;
    expect(blankBtn.className).not.toContain("selected");
  });

  test("clicking a template calls onSelect with the key + seed instructions/desc", () => {
    const onSelect = mock(
      (_key: string, _seed: { instructions: string; desc: string }) => {},
    );
    render(<TemplateStep selected="blank" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("代码审阅"));
    expect(onSelect).toHaveBeenCalled();
    const [key, seed] = onSelect.mock.calls[0]!;
    expect(key).toBe("reviewer");
    expect(seed.instructions).toBe("你是一名严谨的代码审阅者。");
    expect(seed.desc).toBe("审 PR、读代码、定位 bug");
  });
});

describe("IdentityStep", () => {
  test("renders the four primary fields", () => {
    render(
      <IdentityStep
        name=""
        model="gpt-5.5"
        reasoning="low"
        desc=""
        descPlaceholder="example"
        onName={() => {}}
        onModel={() => {}}
        onReasoning={() => {}}
        onDesc={() => {}}
      />,
    );
    expect(screen.getByLabelText(/名称/)).toBeDefined();
    expect(screen.getByLabelText("模型")).toBeDefined();
    // Round 16: reasoning is now a Segmented radiogroup, matching
    // the AgentEditModal's OverviewTab — assert by role.
    expect(screen.getByRole("radiogroup", { name: "推理强度" })).toBeDefined();
    expect(screen.getByLabelText("描述")).toBeDefined();
  });

  test("typing in 名称 invokes onName with the new value", () => {
    const onName = mock((_: string) => {});
    render(
      <IdentityStep
        name=""
        model="gpt-5.5"
        reasoning="low"
        desc=""
        descPlaceholder=""
        onName={onName}
        onModel={() => {}}
        onReasoning={() => {}}
        onDesc={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/名称/), {
      target: { value: "Robin" },
    });
    expect(onName).toHaveBeenCalledWith("Robin");
  });

  test("changing 推理强度 invokes onReasoning", () => {
    const onReasoning = mock((_: string) => {});
    render(
      <IdentityStep
        name=""
        model=""
        reasoning="low"
        desc=""
        descPlaceholder=""
        onName={() => {}}
        onModel={() => {}}
        onReasoning={onReasoning}
        onDesc={() => {}}
      />,
    );
    // Round 16: click the Segmented "深度" radio (value=high).
    fireEvent.click(screen.getByRole("radio", { name: "深度" }));
    expect(onReasoning).toHaveBeenCalledWith("high");
  });

  test("desc placeholder forwards the prop", () => {
    render(
      <IdentityStep
        name=""
        model=""
        reasoning="low"
        desc=""
        descPlaceholder="hint-here"
        onName={() => {}}
        onModel={() => {}}
        onReasoning={() => {}}
        onDesc={() => {}}
      />,
    );
    const desc = screen.getByLabelText("描述") as HTMLTextAreaElement;
    expect(desc.placeholder).toBe("hint-here");
  });
});

describe("PersonaStep", () => {
  test("editing instructions invokes onChange", () => {
    const onChange = mock((_: string) => {});
    render(
      <PersonaStep
        instructions=""
        placeholder="hint"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "be kind" },
    });
    expect(onChange).toHaveBeenCalledWith("be kind");
  });

  test("placeholder is forwarded to the textarea", () => {
    render(
      <PersonaStep
        instructions=""
        placeholder="my-hint"
        onChange={() => {}}
      />,
    );
    const ta = screen.getByLabelText("Instructions") as HTMLTextAreaElement;
    expect(ta.placeholder).toBe("my-hint");
  });

  // ---- Round 16: structural hint + counter + starter chips ----

  test("renders structural hint and char counter (matches PersonaTab)", () => {
    const { container } = render(
      <PersonaStep
        instructions="abc"
        placeholder=""
        onChange={() => {}}
      />,
    );
    expect(screen.getByText(/角色 → 目标 → 行为边界/)).toBeDefined();
    const counter = container.querySelector(".agent-persona-counter");
    expect(counter?.textContent).toBe("3 字符");
  });

  test("starter chips appear only when instructions is empty", () => {
    const { rerender } = render(
      <PersonaStep
        instructions=""
        placeholder=""
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("从模板开始：")).toBeDefined();
    expect(screen.getByRole("button", { name: "通用助手" })).toBeDefined();

    rerender(
      <PersonaStep
        instructions="something"
        placeholder=""
        onChange={() => {}}
      />,
    );
    expect(screen.queryByText("从模板开始：")).toBeNull();
  });

  test("clicking a starter chip invokes onChange with its scaffold body", () => {
    const onChange = mock((_: string) => {});
    render(
      <PersonaStep
        instructions=""
        placeholder=""
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "代码审阅" }));
    expect(onChange).toHaveBeenCalled();
    const value = onChange.mock.calls[0]![0] as string;
    expect(value).toContain("代码审阅者");
    expect(value.length).toBeGreaterThan(50);
  });
});

describe("SkillsStep", () => {
  test("editing the skills text invokes onChange", () => {
    const onChange = mock((_: string) => {});
    render(<SkillsStep skillsText="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Skills"), {
      target: { value: "weather, search" },
    });
    expect(onChange).toHaveBeenCalledWith("weather, search");
  });

  test("renders the default-state preview pill when text is empty", () => {
    render(<SkillsStep skillsText="" onChange={() => {}} />);
    expect(screen.getByText("全部 Skills 可用")).toBeDefined();
  });

  test("renders 已禁用 pill when text is 'none'", () => {
    render(<SkillsStep skillsText="none" onChange={() => {}} />);
    expect(screen.getByText("已禁用")).toBeDefined();
  });

  test("renders one chip per parsed entry", () => {
    const { container } = render(
      <SkillsStep skillsText="alpha, beta, gamma" onChange={() => {}} />,
    );
    const chips = container.querySelectorAll(".agent-skills-chip");
    expect(chips.length).toBe(3);
  });
});

describe("ToolsStep", () => {
  const policy = toolPolicyFromPreset("developer");

  test("renders preset selector + 全选 / 清空 buttons", () => {
    render(
      <ToolsStep toolGroups={[]} toolPolicy={policy} onChange={() => {}} />,
    );
    // Round 16: preset moved from <select> to a Segmented radiogroup.
    expect(screen.getByRole("radiogroup", { name: "工具预设" })).toBeDefined();
    expect(screen.getByRole("button", { name: "全选" })).toBeDefined();
    expect(screen.getByRole("button", { name: "清空" })).toBeDefined();
  });

  test("clicking 清空 calls onChange with the 'none' policy", () => {
    const onChange = mock((_next: typeof policy) => {});
    render(
      <ToolsStep toolGroups={[]} toolPolicy={policy} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0]![0];
    expect(next.toolPreset).toBe("none");
    expect(next.tools).toEqual([]);
  });

  test("changing the preset cascades into a new policy", () => {
    const onChange = mock((_next: typeof policy) => {});
    render(
      <ToolsStep toolGroups={[]} toolPolicy={policy} onChange={onChange} />,
    );
    // Round 16: click the "最小" Segmented radio (value=minimal).
    fireEvent.click(screen.getByRole("radio", { name: "最小" }));
    const next = onChange.mock.calls[0]![0];
    expect(next.toolPreset).toBe("minimal");
  });
});
