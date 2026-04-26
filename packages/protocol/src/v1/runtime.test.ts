import { describe, expect, test } from "bun:test";
import { RuntimeDescriptorSchema, type RuntimeDescriptor } from "./runtime";

describe("RuntimeDescriptor", () => {
  const sample: RuntimeDescriptor = {
    apiVersion: "v1",
    gateway: { port: 4099 },
    shell: { port: 4199 },
    token: "x".repeat(43),
    pid: 1234,
    startedAt: "2026-04-26T00:00:00.000Z" as RuntimeDescriptor["startedAt"],
    shellVersion: "0.1.0",
  };

  test("schema parses a valid descriptor", () => {
    const parsed = RuntimeDescriptorSchema.parse(sample);
    expect(parsed).toEqual(sample);
  });

  test("schema rejects token shorter than 43 chars", () => {
    expect(() =>
      RuntimeDescriptorSchema.parse({ ...sample, token: "short" }),
    ).toThrow();
  });

  test("schema rejects negative port", () => {
    expect(() =>
      RuntimeDescriptorSchema.parse({
        ...sample,
        gateway: { port: -1 },
      }),
    ).toThrow();
  });

  test("schema rejects apiVersion other than 'v1'", () => {
    expect(() =>
      RuntimeDescriptorSchema.parse({ ...sample, apiVersion: "v2" }),
    ).toThrow();
  });
});
