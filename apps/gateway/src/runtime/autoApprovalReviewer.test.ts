import { describe, expect, test } from "bun:test";
import { reviewApprovalRequest } from "./autoApprovalReviewer";

describe("reviewApprovalRequest", () => {
  test("auto-approves public network reads as medium risk", async () => {
    const review = await reviewApprovalRequest({
      runId: "r-1",
      callId: "c-1",
      tool: "web_search",
      input: { query: "OpenAI Agents SDK" },
      workspacePath: "/tmp/work",
      reason: "network access requires approval",
    });

    expect(review).toMatchObject({
      decision: "allow",
      risk: "medium",
    });
  });

  test("escalates destructive shell commands to the user", async () => {
    const review = await reviewApprovalRequest({
      runId: "r-1",
      callId: "c-1",
      tool: "shell.exec",
      input: { argv: ["rm", "-rf", "/tmp/outside-workspace"] },
      workspacePath: "/tmp/work",
      reason: "destructive command requires approval",
    });

    expect(review).toMatchObject({
      decision: "needs_user",
      risk: "high",
    });
  });

  test("denies credential exfiltration attempts as critical risk", async () => {
    const review = await reviewApprovalRequest({
      runId: "r-1",
      callId: "c-1",
      tool: "shell.exec",
      input: { argv: ["cat", "~/.ssh/id_rsa"] },
      workspacePath: "/tmp/work",
      reason: "outside workspace read requires approval",
    });

    expect(review).toMatchObject({
      decision: "deny",
      risk: "critical",
    });
  });
});
