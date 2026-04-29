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
      idempotent: false,
    };
    expect(ToolSchema.parse(t)).toMatchObject({
      name: "shell.exec",
      idempotent: false,
    });
  });

  test("ToolSchema requires an explicit idempotent marker", () => {
    expect(() =>
      ToolSchema.parse({
        name: "read",
        description: "read a file",
        inputSchema: { type: "object" },
        requiresApproval: false,
      }),
    ).toThrow();
  });

  test("ApprovalDecision is allow|deny", () => {
    expect(ApprovalDecisionSchema.parse("allow")).toBe("allow");
    expect(ApprovalDecisionSchema.parse("deny")).toBe("deny");
    expect(() => ApprovalDecisionSchema.parse("maybe")).toThrow();
  });

});
