import { mkdirSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { join } from "node:path";

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

  const stdoutLogPath = join(options.logsDir, `${options.name}.stdout.log`);
  const stderrLogPath = join(options.logsDir, `${options.name}.stderr.log`);

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
    name: options.name,
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

  const writer = createWriteStream(path, { flags: "a" });
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!writer.write(Buffer.from(value))) {
        await onceDrain(writer);
      }
    }
  } finally {
    reader.releaseLock();
    await new Promise<void>((resolve, reject) => {
      writer.end((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function onceDrain(writer: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve) => {
    writer.once("drain", () => resolve());
  });
}
