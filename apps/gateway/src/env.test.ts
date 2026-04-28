import { describe, expect, test } from "bun:test";
import { parseGatewayEnv } from "./env";

describe("parseGatewayEnv", () => {
  const valid = {
    VULTURE_GATEWAY_PORT: "4099",
    VULTURE_GATEWAY_TOKEN: "x".repeat(43),
    VULTURE_SHELL_CALLBACK_URL: "http://127.0.0.1:4199",
    VULTURE_SHELL_PID: "1234",
    VULTURE_PROFILE_DIR: "/tmp/vulture-profile",
  };

  test("parses a complete env", () => {
    const cfg = parseGatewayEnv(valid);
    expect(cfg.port).toBe(4099);
    expect(cfg.token).toHaveLength(43);
    expect(cfg.shellPid).toBe(1234);
    expect(cfg.defaultWorkspace).toBeUndefined();
    expect(cfg.memorySuggestionsEnabled).toBe(false);
  });

  test("enables memory suggestions only with an explicit opt-in", () => {
    const cfg = parseGatewayEnv({
      ...valid,
      VULTURE_MEMORY_SUGGESTIONS: "1",
    });
    expect(cfg.memorySuggestionsEnabled).toBe(true);
  });

  test("parses optional default workspace", () => {
    const cfg = parseGatewayEnv({
      ...valid,
      VULTURE_DEFAULT_WORKSPACE: "/tmp/repo",
    });
    expect(cfg.defaultWorkspace).toBe("/tmp/repo");
  });

  test("rejects missing token", () => {
    const { VULTURE_GATEWAY_TOKEN, ...rest } = valid;
    expect(() => parseGatewayEnv(rest)).toThrow(/VULTURE_GATEWAY_TOKEN/);
  });

  test("rejects non-numeric port", () => {
    expect(() =>
      parseGatewayEnv({ ...valid, VULTURE_GATEWAY_PORT: "abc" }),
    ).toThrow(/VULTURE_GATEWAY_PORT/);
  });

  test("rejects token shorter than 43 chars", () => {
    expect(() =>
      parseGatewayEnv({ ...valid, VULTURE_GATEWAY_TOKEN: "short" }),
    ).toThrow(/VULTURE_GATEWAY_TOKEN/);
  });
});
