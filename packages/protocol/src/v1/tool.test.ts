import { describe, expect, test } from "bun:test";
import {
  ToolSchema,
  ApprovalDecisionSchema,
  type Tool,
} from "./tool";

describe("Tool", () => {
  test("ToolSchema parses sample", () => {
    const t: Tool = {
      name: "shell.exec" as Tool["name"],
      description: "run a command",
      inputSchema: { type: "object" },
      requiresApproval: true,
    };
    expect(ToolSchema.parse(t).name).toBe("shell.exec");
  });

  test("ApprovalDecision is allow|deny", () => {
    expect(ApprovalDecisionSchema.parse("allow")).toBe("allow");
    expect(ApprovalDecisionSchema.parse("deny")).toBe("deny");
    expect(() => ApprovalDecisionSchema.parse("maybe")).toThrow();
  });

});
