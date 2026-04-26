export function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 does not send anything, just probes for existence.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means process exists but we don't have permission to signal it.
    // ESRCH means process does not exist.
    if (
      err instanceof Error &&
      "code" in err &&
      err.code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

export interface WatchdogOptions {
  pid: number;
  intervalMs?: number;
  onDead?: () => void;
}

export function startWatchdog(opts: WatchdogOptions): { stop(): void } {
  const interval = opts.intervalMs ?? 2000;
  const timer = setInterval(() => {
    if (!isProcessAlive(opts.pid)) {
      console.error(`[watchdog] shell pid ${opts.pid} dead; exiting`);
      opts.onDead?.();
      process.exit(0);
    }
  }, interval);
  // do not keep event loop alive on unref
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}
