import { describe, expect, test } from "bun:test";
import { normalizePersistedAgentModel } from "./modelMigration";

describe("normalizePersistedAgentModel", () => {
  test("prefixes bare known OpenAI model ids", () => {
    expect(normalizePersistedAgentModel("gpt-5.5")).toBe("openai/gpt-5.5");
    expect(normalizePersistedAgentModel("gpt-5.4")).toBe("openai/gpt-5.4");
    expect(normalizePersistedAgentModel("gpt-5.4-mini")).toBe("openai/gpt-5.4-mini");
    expect(normalizePersistedAgentModel("gpt-4o")).toBe("openai/gpt-4o");
    expect(normalizePersistedAgentModel("gpt-4o-mini")).toBe("openai/gpt-4o-mini");
    expect(normalizePersistedAgentModel("o3-mini")).toBe("openai/o3-mini");
  });

  test("leaves already qualified refs unchanged", () => {
    expect(normalizePersistedAgentModel("openai/gpt-5.4")).toBe("openai/gpt-5.4");
    expect(normalizePersistedAgentModel("openai/gpt-5.5@codex")).toBe("openai/gpt-5.5@codex");
    expect(normalizePersistedAgentModel("anthropic/claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
  });

  test("maps legacy gateway refs to OpenAI Codex profile refs", () => {
    expect(normalizePersistedAgentModel("gateway/auto")).toBe("openai/gpt-5.5@codex");
    expect(normalizePersistedAgentModel("gateway/long-context")).toBe("openai/gpt-5.5@codex");
    expect(normalizePersistedAgentModel("gateway/cheap")).toBe("openai/gpt-5.4-mini@codex");
  });

  test("trims input before matching known migration refs", () => {
    expect(normalizePersistedAgentModel(" gpt-5.4 ")).toBe("openai/gpt-5.4");
    expect(normalizePersistedAgentModel(" gateway/auto ")).toBe("openai/gpt-5.5@codex");
  });

  test("preserves all-whitespace model values", () => {
    expect(normalizePersistedAgentModel("   ")).toBe("   ");
  });

  test("preserves unknown legacy model values", () => {
    expect(normalizePersistedAgentModel("custom-model")).toBe("custom-model");
    expect(normalizePersistedAgentModel("gpt-3.5-turbo")).toBe("gpt-3.5-turbo");
    expect(normalizePersistedAgentModel("gateway/special")).toBe("gateway/special");
  });
});
