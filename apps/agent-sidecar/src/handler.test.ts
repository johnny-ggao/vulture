import { describe, expect, test } from "bun:test";
import { createRequestHandler } from "./handler";

const validRunParams = {
  profileId: "default",
  workspaceId: "vulture",
  agentId: "local-work-agent",
  input: "hello",
};

describe("sidecar request handler", () => {
  test("malformed json returns PARSE_ERROR and does not throw", async () => {
    const handleLine = createRequestHandler();

    await expect(handleLine("{not json")).resolves.toMatchObject({
      error: { code: "PARSE_ERROR", recoverable: true },
    });
  });

  test("invalid run.create params returns INVALID_PARAMS and does not throw", async () => {
    const handleLine = createRequestHandler();

    await expect(
      handleLine('{"id":"1","method":"run.create","params":{"input":""}}'),
    ).resolves.toMatchObject({
      id: "1",
      error: { code: "INVALID_PARAMS", recoverable: true },
    });
  });

  test("runtime failure returns RUN_FAILED and does not throw", async () => {
    const handleLine = createRequestHandler({
      runAgent: async () => {
        throw new Error("agent exploded");
      },
    });

    await expect(
      handleLine(JSON.stringify({ id: "1", method: "run.create", params: validRunParams })),
    ).resolves.toMatchObject({
      id: "1",
      error: { code: "RUN_FAILED", recoverable: true },
    });
  });

  test("tool requests use the active run id", async () => {
    const emitted: unknown[] = [];
    const handleLine = createRequestHandler({
      writeMessage: (message) => emitted.push(message),
      runAgent: async (_params, createGateway) => {
        const gateway = createGateway("run_active");
        await gateway.request("shell.exec", { cwd: "/tmp", argv: ["pwd"] });
        return [];
      },
    });

    await handleLine(JSON.stringify({ id: "1", method: "run.create", params: validRunParams }));

    expect(emitted).toEqual([
      {
        method: "tool.request",
        params: {
          runId: "run_active",
          tool: "shell.exec",
          input: { cwd: "/tmp", argv: ["pwd"] },
        },
      },
    ]);
  });

  test("one bad line does not prevent later valid lines", async () => {
    const handleLine = createRequestHandler();

    const bad = await handleLine("{not json");
    const good = await handleLine('{"id":"2","method":"health.check","params":{}}');

    expect(bad.error?.code).toBe("PARSE_ERROR");
    expect(good).toEqual({ id: "2", result: { ok: true, runtime: "bun" } });
  });
});
