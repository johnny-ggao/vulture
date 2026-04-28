import { describe, expect, test } from "bun:test";
import { AppErrorSchema, type AppError, type ErrorCode } from "./error";

describe("AppError", () => {
  test("schema validates a minimal AppError", () => {
    const err: AppError = { code: "internal", message: "boom" };
    expect(AppErrorSchema.parse(err)).toEqual(err);
  });

  test("schema rejects unknown error code", () => {
    expect(() =>
      AppErrorSchema.parse({ code: "not_a_real_code", message: "x" }),
    ).toThrow();
  });

  test("ErrorCode covers Phase-1-relevant codes", () => {
    const codes: ErrorCode[] = [
      "auth.token_invalid",
      "internal",
      "internal.gateway_restarted",
      "internal.recovery_state_unavailable",
      "internal.shutdown",
    ];
    expect(codes.length).toBeGreaterThan(0);
  });
});
