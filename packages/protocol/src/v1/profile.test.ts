import { describe, expect, test } from "bun:test";
import { ProfileSchema, UpdateProfileRequestSchema, type Profile } from "./profile";

describe("Profile schema", () => {
  const sample: Profile = {
    id: "default" as Profile["id"],
    name: "Default",
    activeAgentId: "local-work-agent" as Profile["activeAgentId"],
    createdAt: "2026-04-26T00:00:00.000Z" as Profile["createdAt"],
    updatedAt: "2026-04-26T00:00:00.000Z" as Profile["updatedAt"],
  };

  test("parses a valid profile", () => {
    expect(ProfileSchema.parse(sample)).toEqual(sample);
  });

  test("activeAgentId may be null", () => {
    expect(ProfileSchema.parse({ ...sample, activeAgentId: null }).activeAgentId).toBeNull();
  });

  test("UpdateProfileRequest accepts partial updates", () => {
    expect(UpdateProfileRequestSchema.parse({})).toEqual({});
    expect(UpdateProfileRequestSchema.parse({ name: "x" })).toEqual({ name: "x" });
    expect(
      UpdateProfileRequestSchema.parse({ activeAgentId: "agent-1" }),
    ).toEqual({ activeAgentId: "agent-1" });
  });
});
