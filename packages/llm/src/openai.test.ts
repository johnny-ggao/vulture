import { describe, expect, test } from "bun:test";
import { selectModel, isApiKeyConfigured } from "./openai";

describe("openai helpers", () => {
  test("selectModel falls back to default for unsupported names", () => {
    expect(selectModel("gpt-5.5")).toBe("gpt-5.5");
    expect(selectModel("")).toBe("gpt-5.5");
    expect(selectModel("definitely-not-real")).toBe("gpt-5.5");
  });

  test("isApiKeyConfigured: true if env var present and non-empty", () => {
    expect(isApiKeyConfigured({})).toBe(false);
    expect(isApiKeyConfigured({ OPENAI_API_KEY: "" })).toBe(false);
    expect(isApiKeyConfigured({ OPENAI_API_KEY: "sk-x" })).toBe(true);
  });
});
