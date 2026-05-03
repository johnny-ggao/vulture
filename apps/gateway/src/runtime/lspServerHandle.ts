import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface LspTransport {
  send(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  dispose(): Promise<void>;
}

export type LspLanguage = "typescript" | "rust";

export class LspServerHandle {
  private static readonly DEFAULT_INIT_TIMEOUT_MS = 30_000;

  private initPromise: Promise<void> | null = null;
  private openedFiles = new Set<string>();
  private _lastUsedAt = Date.now();
  private disposed = false;

  constructor(
    private readonly transport: LspTransport,
    private readonly workspaceRoot: string,
    private readonly language: LspLanguage,
    private readonly initTimeoutMs: number = LspServerHandle.DEFAULT_INIT_TIMEOUT_MS,
  ) {}

  get lastUsedAt(): number {
    return this._lastUsedAt;
  }

  touch(): void {
    this._lastUsedAt = Date.now();
  }

  async ready(): Promise<void> {
    if (this.disposed) throw new Error("LspServerHandle already disposed");
    if (!this.initPromise) {
      this.initPromise = (async () => {
        let timerId: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.transport.send("initialize", {
              processId: process.pid,
              rootUri: pathToFileUri(this.workspaceRoot),
              capabilities: {
                textDocument: {
                  publishDiagnostics: { relatedInformation: true },
                  definition: {},
                  references: {},
                  hover: { contentFormat: ["markdown", "plaintext"] },
                },
              },
            }),
            new Promise<never>((_, reject) => {
              timerId = setTimeout(
                () =>
                  reject(
                    new Error(
                      `lsp init timeout after ${this.initTimeoutMs}ms`,
                    ),
                  ),
                this.initTimeoutMs,
              );
            }),
          ]);
          this.transport.notify("initialized", {});
        } catch (err) {
          this.initPromise = null; // allow retry after failure
          throw err;
        } finally {
          if (timerId !== undefined) clearTimeout(timerId);
        }
      })();
    }
    return this.initPromise;
  }

  async ensureOpen(filePath: string, languageId: string): Promise<void> {
    await this.ready();
    if (this.openedFiles.has(filePath)) return;
    this.openedFiles.add(filePath);
    try {
      const text = await readFile(filePath, "utf8");
      this.transport.notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToFileUri(filePath),
          languageId,
          version: 1,
          text,
        },
      });
    } catch (err) {
      this.openedFiles.delete(filePath);
      throw err;
    }
  }

  async send(method: string, params: unknown): Promise<unknown> {
    await this.ready();
    this.touch();
    return this.transport.send(method, params);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.transport.send("shutdown", null);
      this.transport.notify("exit", null);
    } catch {
      // best-effort: server may already be dead; exit notification skipped
    }
    await this.transport.dispose();
  }
}

export function pathToFileUri(path: string): string {
  return pathToFileURL(path).href;
}
