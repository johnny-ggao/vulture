import { describe, expect, test } from "bun:test";
import { parseJsonLine, serializeMessage } from "./rpc";

describe("sidecar rpc", () => {
  test("parses valid json rpc lines", () => {
    const message = parseJsonLine('{"id":"1","method":"health.check","params":{}}');
    expect(message.method).toBe("health.check");
  });

  test("serializes messages as newline-delimited json", () => {
    expect(serializeMessage({ id: "1", result: { ok: true } })).toBe(
      '{"id":"1","result":{"ok":true}}\n',
    );
  });
});
