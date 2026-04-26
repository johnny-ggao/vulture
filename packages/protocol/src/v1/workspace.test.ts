import { describe, expect, test } from "bun:test";
import {
  WorkspaceSchema,
  SaveWorkspaceRequestSchema,
  type Workspace,
} from "./workspace";

describe("Workspace schema", () => {
  const sample: Workspace = {
    id: "vulture" as Workspace["id"],
    name: "Vulture",
    path: "/Users/johnny/Work/vulture",
    createdAt: "2026-04-26T00:00:00.000Z" as Workspace["createdAt"],
    updatedAt: "2026-04-26T00:00:00.000Z" as Workspace["updatedAt"],
  };

  test("parses a valid workspace", () => {
    expect(WorkspaceSchema.parse(sample)).toEqual(sample);
  });

  test("rejects empty path", () => {
    expect(() => WorkspaceSchema.parse({ ...sample, path: "" })).toThrow();
  });

  test("SaveWorkspaceRequest is name + path + id", () => {
    expect(
      SaveWorkspaceRequestSchema.parse({
        id: "vulture",
        name: "Vulture",
        path: "/Users/johnny/Work/vulture",
      }),
    ).toEqual({
      id: "vulture",
      name: "Vulture",
      path: "/Users/johnny/Work/vulture",
    });
  });
});
