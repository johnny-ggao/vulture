export interface SummarizeToolInputOptions {
  full?: boolean;
}

export function summarizeToolInput(
  tool: string,
  input: unknown,
  _opts: SummarizeToolInputOptions = {},
): string {
  if (input === undefined || input === null) return "";
  if (tool === "shell.exec") return summarizeShellExec(input);
  if (typeof input === "string") return input;
  return stringifyInput(input);
}

function summarizeShellExec(input: unknown): string {
  if (!isRecord(input)) return stringifyInput(input);
  const argv = Array.isArray(input.argv)
    ? input.argv.filter((item): item is string => typeof item === "string")
    : [];
  const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : "";
  const command = argv.length > 0 ? argv.map(shellQuote).join(" ") : stringifyInput(input);
  return cwd ? `cwd: ${cwd}\n$ ${command}` : `$ ${command}`;
}

function stringifyInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
