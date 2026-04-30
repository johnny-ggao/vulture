import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Hono } from "hono";

export function runtimeDiagnosticsRouter(): Hono {
  const app = new Hono();

  app.get("/v1/runtime/diagnostics", (c) => {
    return c.json({
      runtime: {
        bun: typeof Bun !== "undefined" ? Bun.version : null,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
      executables: {
        bun: executableStatus("bun"),
        node: executableStatus("node"),
        git: executableStatus("git"),
        python3: executableStatus("python3"),
        python: executableStatus("python"),
      },
    });
  });

  return app;
}

function executableStatus(name: string) {
  const path = findExecutable(name);
  return {
    available: path !== null,
    path,
  };
}

function findExecutable(name: string): string | null {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH.
    }
  }
  return null;
}
