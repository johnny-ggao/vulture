import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export interface StartProcessOptions {
  name: string;
  argv: [string, ...string[]];
  cwd: string;
  logsDir: string;
  env?: Record<string, string | undefined>;
}

export interface ManagedProcess {
  readonly name: string;
  readonly pid: number | undefined;
  readonly stdoutLogPath: string;
  readonly stderrLogPath: string;
  readonly exit: Promise<ProcessExitResult>;
  stop(signal?: NodeJS.Signals): Promise<ProcessExitResult>;
}

export interface ProcessExitResult {
  exitCode: number;
}

export function startProcess(options: StartProcessOptions): ManagedProcess {
  mkdirSync(options.logsDir, { recursive: true });

  const safeName = sanitizeProcessName(options.name);
  const stdoutLogPath = join(options.logsDir, `${safeName}.stdout.log`);
  const stderrLogPath = join(options.logsDir, `${safeName}.stderr.log`);

  writeFileSync(stdoutLogPath, "");
  writeFileSync(stderrLogPath, "");

  const child = Bun.spawn({
    cmd: options.argv,
    cwd: options.cwd,
    env: mergeEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const stdoutDone = pipeStreamToFile(child.stdout, stdoutLogPath);
  const stderrDone = pipeStreamToFile(child.stderr, stderrLogPath);

  const exit = Promise.all([child.exited, stdoutDone, stderrDone]).then(([exitCode]) => ({
    exitCode,
  }));

  let stopPromise: Promise<ProcessExitResult> | null = null;

  return {
    name: safeName,
    pid: child.pid,
    stdoutLogPath,
    stderrLogPath,
    exit,
    async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<ProcessExitResult> {
      if (!stopPromise) {
        try {
          child.kill(signal);
        } catch {
          // Ignore kill errors so callers can still await process exit.
        }
        stopPromise = exit;
      }

      return await stopPromise;
    },
  };
}

function mergeEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }

  return merged;
}

async function pipeStreamToFile(stream: ReadableStream<Uint8Array> | null, path: string): Promise<void> {
  if (!stream) {
    return;
  }

  await pipeline(
    Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>),
    createWriteStream(path, { flags: "a" }),
  );
}

function sanitizeProcessName(value: string): string {
  const safeName = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safeName.length > 0 ? safeName : "process";
}
