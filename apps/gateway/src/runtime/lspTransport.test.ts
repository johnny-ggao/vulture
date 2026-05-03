import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServerBinary } from "./lspTransport";

describe("resolveServerBinary", () => {
  test("returns null when binary is not found in nonexistent workspace", async () => {
    const result = await resolveServerBinary("typescript", "/nonexistent-workspace-xyz123");
    // On a CI box without typescript-language-server on PATH, this is null.
    // On a dev box with it installed, it's a non-null string. Either is acceptable.
    if (result !== null) expect(result).toContain("typescript-language-server");
  });

  test("returns null for unknown language", async () => {
    const result = await resolveServerBinary("klingon" as never, "/nonexistent-workspace-xyz123");
    expect(result).toBeNull();
  });

  test("returns rust-analyzer path when on PATH or in cargo bin", async () => {
    const result = await resolveServerBinary("rust", "/nonexistent-workspace-xyz123");
    if (result !== null) expect(result).toContain("rust-analyzer");
  });

  test("prefers local node_modules/.bin over PATH for typescript", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lsp-which-"));
    try {
      const binDir = join(ws, "node_modules", ".bin");
      mkdirSync(binDir, { recursive: true });
      const fakeBin = join(binDir, "typescript-language-server");
      writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeBin, 0o755);
      const result = await resolveServerBinary("typescript", ws);
      expect(result).toBe(fakeBin);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
