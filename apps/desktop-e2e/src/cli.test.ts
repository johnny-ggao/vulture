import { describe, expect, test } from "bun:test";

import { main, parseDesktopE2EArgs, selectDesktopScenarios } from "./cli";
import { desktopScenarios } from "./scenarios";

describe("desktop e2e cli", () => {
  test("parses list and separated scenario/tag args", () => {
    expect(
      parseDesktopE2EArgs(["--list", "--scenario", "launch-smoke", "--tag", "smoke,recovery"]),
    ).toEqual({
      list: true,
      scenarios: ["launch-smoke"],
      tags: ["smoke", "recovery"],
    });
  });

  test("parses equals syntax for scenario and tag args", () => {
    expect(parseDesktopE2EArgs(["--scenario=chat-send-smoke", "--tag=desktop,navigation"])).toEqual({
      list: false,
      scenarios: ["chat-send-smoke"],
      tags: ["desktop", "navigation"],
    });
  });

  test("uses environment defaults for scenarios and tags", () => {
    expect(
      parseDesktopE2EArgs([], {
        VULTURE_DESKTOP_E2E_SCENARIOS: "launch-smoke, chat-send-smoke",
        VULTURE_DESKTOP_E2E_TAGS: "desktop, smoke",
      }),
    ).toEqual({
      list: false,
      scenarios: ["launch-smoke", "chat-send-smoke"],
      tags: ["desktop", "smoke"],
    });
  });

  test("selects scenarios by exact id", () => {
    expect(
      selectDesktopScenarios({ scenarios: ["chat-send-smoke", "launch-smoke"], tags: [] }, desktopScenarios).map(
        (scenario) => scenario.id,
      ),
    ).toEqual(["chat-send-smoke", "launch-smoke"]);
  });

  test("selects scenarios by tag when no explicit scenario ids are provided", () => {
    expect(
      selectDesktopScenarios({ scenarios: [], tags: ["navigation"] }, desktopScenarios).map((scenario) => scenario.id),
    ).toEqual(["navigation-smoke"]);
  });

  test("explicit scenario ids override tag filtering", () => {
    expect(
      selectDesktopScenarios({ scenarios: ["launch-smoke"], tags: ["navigation"] }, desktopScenarios).map(
        (scenario) => scenario.id,
      ),
    ).toEqual(["launch-smoke"]);
  });

  test("throws for unknown scenario ids", () => {
    expect(() =>
      selectDesktopScenarios({ scenarios: ["missing-scenario"], tags: [] }, desktopScenarios),
    ).toThrow("Unknown desktop E2E scenario missing-scenario");
  });

  test("lists selected scenarios with id name and tags", () => {
    const lines: string[] = [];

    const exitCode = main(["--list", "--tag", "smoke"], {
      write: (message) => {
        lines.push(message);
      },
      writeError: () => {
        throw new Error("did not expect stderr output");
      },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual([
      "launch-smoke\tLaunch smoke\tdesktop,smoke",
      "chat-send-smoke\tChat send smoke\tdesktop,smoke,chat",
    ]);
  });

  test("returns exit code 1 until the real driver is enabled", () => {
    const errors: string[] = [];

    const exitCode = main(["--scenario", "launch-smoke"], {
      write: () => {
        throw new Error("did not expect stdout output");
      },
      writeError: (message) => {
        errors.push(message);
      },
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(["Desktop E2E real driver is intentionally disabled until Task 6/7 wiring lands."]);
  });
});
