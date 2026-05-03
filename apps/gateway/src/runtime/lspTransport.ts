import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { LspLanguage, LspTransport } from "./lspServerHandle";

export async function resolveServerBinary(
  language: LspLanguage,
  workspaceRoot: string,
): Promise<string | null> {
  if (language === "typescript") {
    const local = join(workspaceRoot, "node_modules", ".bin", "typescript-language-server");
    if (existsSync(local)) return local;
    return whichSync("typescript-language-server");
  }
  if (language === "rust") {
    const fromWhich = whichSync("rust-analyzer");
    if (fromWhich) return fromWhich;
    const cargoBin = join(homedir(), ".cargo", "bin", "rust-analyzer");
    if (existsSync(cargoBin)) return cargoBin;
    return null;
  }
  return null;
}

function whichSync(cmd: string): string | null {
  const result = spawnSync("which", [cmd], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const line = result.stdout.trim().split("\n")[0];
  return line || null;
}

export async function createRealTransport(
  workspaceRoot: string,
  language: LspLanguage,
): Promise<LspTransport | null> {
  const binary = await resolveServerBinary(language, workspaceRoot);
  if (!binary) return null;
  const args = language === "typescript" ? ["--stdio"] : [];
  const child = spawn(binary, args, {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();

  return {
    async send(method, params) {
      return await connection.sendRequest(method, params ?? null);
    },
    notify(method, params) {
      void connection.sendNotification(method, params ?? null);
    },
    async dispose() {
      try {
        connection.dispose();
      } catch {
        // best-effort
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    },
  };
}
