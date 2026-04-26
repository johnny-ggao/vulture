import { describe, expect, test } from "bun:test";
import { API_VERSION, type Iso8601, brandIso8601 } from "./index";

describe("v1 protocol primitives", () => {
  test("API_VERSION is the literal 'v1'", () => {
    const v: "v1" = API_VERSION;
    expect(v).toBe("v1");
  });

  test("brandIso8601 accepts well-formed RFC 3339 timestamp", () => {
    const t: Iso8601 = brandIso8601("2026-04-26T12:34:56.789Z");
    expect(t as string).toBe("2026-04-26T12:34:56.789Z");
  });

  test("brandIso8601 rejects non-RFC-3339 strings", () => {
    expect(() => brandIso8601("not a date")).toThrow();
  });
});
