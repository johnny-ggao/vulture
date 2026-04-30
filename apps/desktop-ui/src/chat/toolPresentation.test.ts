import { describe, expect, test } from "bun:test";
import { summarizeToolInput } from "./toolPresentation";

describe("summarizeToolInput", () => {
  test("formats shell.exec input as a $-prefixed command line", () => {
    expect(summarizeToolInput("shell.exec", { argv: ["ls", "-la"] })).toBe(
      "$ ls -la",
    );
  });

  test("shell.exec quotes args with whitespace or special characters", () => {
    expect(
      summarizeToolInput("shell.exec", { argv: ["echo", "hello world"] }),
    ).toBe("$ echo 'hello world'");
  });

  test("shell.exec escapes single-quotes inside an arg", () => {
    expect(
      summarizeToolInput("shell.exec", { argv: ["echo", "it's fine"] }),
    ).toBe("$ echo 'it'\\''s fine'");
  });

  test("shell.exec includes cwd when present", () => {
    expect(
      summarizeToolInput("shell.exec", {
        argv: ["pwd"],
        cwd: "/Users/x/proj",
      }),
    ).toBe("cwd: /Users/x/proj\n$ pwd");
  });

  test("non-shell tool with string input returns the string verbatim", () => {
    expect(summarizeToolInput("notes.write", "remember to clean up")).toBe(
      "remember to clean up",
    );
  });

  test("non-shell tool with object input falls back to pretty JSON", () => {
    const out = summarizeToolInput("custom", { url: "https://example.com" });
    expect(out).toContain("https://example.com");
    expect(out).toContain("\n"); // pretty-printed
  });

  test("returns empty string for null / undefined input", () => {
    expect(summarizeToolInput("shell.exec", null)).toBe("");
    expect(summarizeToolInput("shell.exec", undefined)).toBe("");
  });

  test("shell.exec falls back to JSON when argv is missing", () => {
    expect(summarizeToolInput("shell.exec", { invalid: 1 })).toContain("invalid");
  });
});
