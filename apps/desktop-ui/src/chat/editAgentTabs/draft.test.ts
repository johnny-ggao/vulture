import { describe, expect, test } from "bun:test";
import {
  draftFromAgent,
  isDirtyDraft,
  parseSkills,
  sameStringSet,
  type Draft,
} from "./draft";
import { localAgentFixture as baseAgent } from "../__fixtures__/agent";

describe("draftFromAgent", () => {
  test("maps a saved agent into a Draft", () => {
    const draft = draftFromAgent(baseAgent);
    expect(draft.name).toBe("Local Agent");
    expect(draft.model).toBe("gpt-5.4");
    expect(draft.reasoning).toBe("medium");
    expect(draft.tools).toEqual(["read", "shell.exec"]);
    expect(draft.toolPreset).toBe("developer");
    expect(draft.instructions).toBe("behave");
  });

  test("returns sensible defaults when agent is null", () => {
    const draft = draftFromAgent(null);
    expect(draft.name).toBe("");
    expect(draft.model).toBe("");
    expect(draft.reasoning).toBe("medium");
    expect(draft.tools).toEqual([]);
    expect(draft.toolPreset).toBe("none");
    expect(draft.skillsText).toBe("");
  });

  test("encodes skills tri-state into skillsText", () => {
    expect(draftFromAgent({ ...baseAgent, skills: undefined }).skillsText).toBe("");
    expect(draftFromAgent({ ...baseAgent, skills: [] as string[] }).skillsText).toBe("none");
    expect(
      draftFromAgent({ ...baseAgent, skills: ["a", "b"] as string[] }).skillsText,
    ).toBe("a, b");
  });

  test("clones the tools array — mutating the draft must not poison the agent", () => {
    const draft = draftFromAgent(baseAgent);
    draft.tools.push("write");
    expect(baseAgent.tools).toEqual(["read", "shell.exec"]);
  });
});

describe("parseSkills", () => {
  test("returns null for an empty/whitespace string (skills field omitted)", () => {
    expect(parseSkills("")).toBeNull();
    expect(parseSkills("   ")).toBeNull();
    expect(parseSkills("\n\n")).toBeNull();
  });

  test("returns [] for the literal 'none' (case-insensitive, whitespace-tolerant)", () => {
    expect(parseSkills("none")).toEqual([]);
    expect(parseSkills("NONE")).toEqual([]);
    expect(parseSkills("  none  ")).toEqual([]);
  });

  test("returns the splatted allowlist for comma/newline separated input", () => {
    expect(parseSkills("a, b, c")).toEqual(["a", "b", "c"]);
    expect(parseSkills("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(parseSkills("a , , b")).toEqual(["a", "b"]);
  });

  test("'none' is only treated as the disable sentinel when it is the entire trimmed input", () => {
    // "none, foo" should be a literal allowlist [none, foo], not the empty list.
    expect(parseSkills("none, foo")).toEqual(["none", "foo"]);
  });
});

describe("sameStringSet", () => {
  test("returns true for permutations of the same elements", () => {
    expect(sameStringSet(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
  });

  test("returns false when sizes differ", () => {
    expect(sameStringSet(["a"], ["a", "b"])).toBe(false);
  });

  test("returns false when contents differ", () => {
    expect(sameStringSet(["a", "b"], ["a", "c"])).toBe(false);
  });

  test("treats empty arrays as equal", () => {
    expect(sameStringSet([], [])).toBe(true);
  });
});

describe("isDirtyDraft", () => {
  test("matching draft is clean", () => {
    expect(isDirtyDraft(draftFromAgent(baseAgent), baseAgent)).toBe(false);
  });

  test("returns false when agent is null (nothing to compare against)", () => {
    expect(isDirtyDraft(draftFromAgent(null), null)).toBe(false);
  });

  test("detects a name edit", () => {
    const draft: Draft = { ...draftFromAgent(baseAgent), name: "Renamed" };
    expect(isDirtyDraft(draft, baseAgent)).toBe(true);
  });

  test("detects a tools change even when length is preserved", () => {
    const draft: Draft = {
      ...draftFromAgent(baseAgent),
      tools: ["read", "browser.snapshot"],
    };
    expect(isDirtyDraft(draft, baseAgent)).toBe(true);
  });

  test("detects a tools reorder as clean (set equality)", () => {
    const draft: Draft = {
      ...draftFromAgent(baseAgent),
      tools: ["shell.exec", "read"],
    };
    expect(isDirtyDraft(draft, baseAgent)).toBe(false);
  });
});
