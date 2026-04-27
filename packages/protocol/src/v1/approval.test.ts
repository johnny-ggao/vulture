import { describe, expect, test } from "bun:test";
import { ApprovalRequestSchema } from "./approval";

describe("ApprovalRequestSchema", () => {
  test("parses allow decision", () => {
    expect(ApprovalRequestSchema.parse({ callId: "c1", decision: "allow" })).toEqual({
      callId: "c1",
      decision: "allow",
    });
  });

  test("parses deny decision", () => {
    expect(ApprovalRequestSchema.parse({ callId: "c1", decision: "deny" }).decision).toBe("deny");
  });

  test("rejects unknown decision", () => {
    expect(() => ApprovalRequestSchema.parse({ callId: "c1", decision: "maybe" })).toThrow();
  });

  test("rejects empty callId", () => {
    expect(() => ApprovalRequestSchema.parse({ callId: "", decision: "allow" })).toThrow();
  });

  test("rejects extra fields (strict)", () => {
    expect(() =>
      ApprovalRequestSchema.parse({ callId: "c1", decision: "allow", extra: "nope" }),
    ).toThrow();
  });
});
