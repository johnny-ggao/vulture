import { describe, expect, test } from "bun:test";
import { hashHue } from "./agentHue";

describe("hashHue", () => {
  test("returns a value in [0, 360)", () => {
    for (const id of ["a", "agent-1", "longer-id-with-dashes", "中文 id"]) {
      const h = hashHue(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  test("is deterministic — same input always gives same hue", () => {
    expect(hashHue("agent-x")).toBe(hashHue("agent-x"));
    expect(hashHue("")).toBe(hashHue(""));
  });

  test("different ids produce different hues most of the time", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const hues = new Set(ids.map((id) => hashHue(id)));
    // Birthday paradox kicks in past ~19 ids; for 10 we expect at least 6
    // unique buckets (collision resistance is the point of FNV-1a).
    expect(hues.size).toBeGreaterThanOrEqual(6);
  });

  test("treats `null` and `undefined` as the empty string (no throw)", () => {
    // Defense added because HistoryDrawer fixtures cast object literals to
    // ConversationDto without an `agentId`. The function must not throw.
    const empty = hashHue("");
    expect(hashHue(null)).toBe(empty);
    expect(hashHue(undefined)).toBe(empty);
  });

  test("handles long strings without issue", () => {
    const long = "x".repeat(10_000);
    const h = hashHue(long);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});
