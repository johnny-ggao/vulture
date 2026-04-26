import { describe, expect, test } from "bun:test";
import { brandId, type BrandedId } from "./ids";

type FooId = BrandedId<"Foo">;

describe("brandId", () => {
  test("returns the same string value", () => {
    const id = brandId<FooId>("abc");
    expect(id).toBe("abc");
  });

  test("rejects empty string", () => {
    expect(() => brandId<FooId>("")).toThrow("id must not be empty");
  });
});
