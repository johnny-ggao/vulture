import { describe, expect, test } from "bun:test";
import { isProcessAlive } from "./watchdog";

describe("isProcessAlive", () => {
  test("current process is alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("PID 1 is alive (init)", () => {
    expect(isProcessAlive(1)).toBe(true);
  });

  test("very high PID is dead", () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
  });
});
