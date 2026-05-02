import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findHarnessRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
          name?: string;
          workspaces?: unknown;
        };
        if (parsed.name === "vulture" || parsed.workspaces !== undefined) return current;
      } catch {
        // Keep walking; malformed package files should not hide a parent root.
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}
