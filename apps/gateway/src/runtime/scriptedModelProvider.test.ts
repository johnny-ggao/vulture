import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { makeScriptedModelProvider } from "./scriptedModelProvider";

const REQUEST: ModelRequest = {
  input: "hello",
  modelSettings: {},
  tools: [],
  outputType: "text",
  handoffs: [],
  tracing: false,
};

async function collectStream(
  iter: AsyncIterable<unknown>,
): Promise<Array<{ type: string } & Record<string, unknown>>> {
  const out: Array<{ type: string } & Record<string, unknown>> = [];
  for await (const value of iter) {
    out.push(value as { type: string } & Record<string, unknown>);
  }
  return out;
}

describe("ScriptedModelProvider", () => {
  test("returns the configured fallback turn when no script is set", async () => {
    const controller = makeScriptedModelProvider();
    const model = await controller.provider.getModel();
    const events = await collectStream(model.getStreamedResponse(REQUEST));
    expect(events.map((entry) => entry.type)).toEqual([
      "response_started",
      "output_text_delta",
      "response_done",
    ]);
    expect((events[1] as unknown as { delta: string }).delta).toBe(
      "scripted model: no script set",
    );
  });

  test("hands the runner one turn per getStreamedResponse call", async () => {
    const controller = makeScriptedModelProvider();
    controller.setStep({
      turns: [
        {
          toolCalls: [
            {
              callId: "c-1",
              name: "harness_test_approval",
              arguments: { message: "first" },
            },
          ],
        },
        { text: "tool ran, here is the final" },
      ],
    });
    const model = await controller.provider.getModel();

    const turn1 = await collectStream(model.getStreamedResponse(REQUEST));
    const done1 = turn1.find((entry) => entry.type === "response_done") as unknown as {
      response: { output: Array<Record<string, unknown>> };
    };
    expect(done1.response.output).toEqual([
      {
        type: "function_call",
        callId: "c-1",
        name: "harness_test_approval",
        status: "completed",
        arguments: '{"message":"first"}',
      },
    ]);

    const turn2 = await collectStream(model.getStreamedResponse(REQUEST));
    const done2 = turn2.find((entry) => entry.type === "response_done") as unknown as {
      response: { output: Array<Record<string, unknown>> };
    };
    expect(done2.response.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "tool ran, here is the final" }],
      },
    ]);

    expect(controller.turnsConsumed()).toBe(2);
  });

  test("setStep resets the turn cursor", async () => {
    const controller = makeScriptedModelProvider();
    controller.setStep({ turns: [{ text: "first" }, { text: "second" }] });
    const model = await controller.provider.getModel();
    await collectStream(model.getStreamedResponse(REQUEST));
    expect(controller.turnsConsumed()).toBe(1);

    controller.setStep({ turns: [{ text: "different first" }] });
    expect(controller.turnsConsumed()).toBe(0);
    const events = await collectStream(model.getStreamedResponse(REQUEST));
    expect((events[1] as unknown as { delta: string }).delta).toBe("different first");
  });

  test("falls back to script-exhausted text when the runner asks for more turns than provided", async () => {
    const controller = makeScriptedModelProvider();
    controller.setStep({ turns: [{ text: "only one" }] });
    const model = await controller.provider.getModel();
    await collectStream(model.getStreamedResponse(REQUEST));
    const overrun = await collectStream(model.getStreamedResponse(REQUEST));
    expect((overrun[1] as unknown as { delta: string }).delta).toBe(
      "scripted model: script exhausted",
    );
  });

  test("getResponse mirrors getStreamedResponse output", async () => {
    const controller = makeScriptedModelProvider();
    controller.setStep({
      turns: [
        {
          text: "hi",
          toolCalls: [
            { callId: "c-1", name: "noop", arguments: { ok: true } },
          ],
        },
      ],
    });
    const model = await controller.provider.getModel();
    const response = await model.getResponse(REQUEST);
    expect(response.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hi" }],
      },
      {
        type: "function_call",
        callId: "c-1",
        name: "noop",
        status: "completed",
        arguments: '{"ok":true}',
      },
    ]);
  });

  test("reset() clears the active script", async () => {
    const controller = makeScriptedModelProvider();
    controller.setStep({ turns: [{ text: "set" }] });
    expect(controller.current()).not.toBeNull();
    controller.reset();
    expect(controller.current()).toBeNull();
    expect(controller.turnsConsumed()).toBe(0);
  });
});
