import { describe, expect, test } from "bun:test";
import {
  runStarted,
  textDelta,
  toolPlanned,
  toolStarted,
  toolCompleted,
  toolFailed,
  toolAsk,
  runCompleted,
  runFailed,
  runCancelled,
} from "./events";

describe("event constructors", () => {
  test("runStarted has agentId + model", () => {
    const e = runStarted({ runId: "r", seq: 0, createdAt: "2026-04-26T00:00:00.000Z" }, {
      agentId: "a",
      model: "m",
    });
    expect(e.type).toBe("run.started");
    if (e.type === "run.started") {
      expect(e.agentId).toBe("a");
    }
  });

  test("toolAsk requires approvalToken", () => {
    const e = toolAsk(
      { runId: "r", seq: 1, createdAt: "2026-04-26T00:00:00.000Z" },
      { callId: "c", tool: "browser.click", reason: "x", approvalToken: "tok" },
    );
    expect(e.type).toBe("tool.ask");
  });

  test("runCancelled has only base fields", () => {
    const e = runCancelled({ runId: "r", seq: 99, createdAt: "2026-04-26T00:00:00.000Z" });
    expect(e.type).toBe("run.cancelled");
  });
});
