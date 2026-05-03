import { readFile } from "node:fs/promises";

export interface LspTransport {
  send(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  dispose(): Promise<void>;
}

export type LspLanguage = "typescript" | "rust";

export class LspServerHandle {
  private initPromise: Promise<void> | null = null;
  private openedFiles = new Set<string>();
  private _lastUsedAt = Date.now();

  constructor(
    private readonly transport: LspTransport,
    private readonly workspaceRoot: string,
    private readonly language: LspLanguage,
  ) {}

  get lastUsedAt(): number {
    return this._lastUsedAt;
  }

  touch(): void {
    this._lastUsedAt = Date.now();
  }

  async ready(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.transport.send("initialize", {
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
        });
        this.transport.notify("initialized", {});
      })();
    }
    return this.initPromise;
  }

  async ensureOpen(filePath: string, languageId: string): Promise<void> {
    await this.ready();
    if (this.openedFiles.has(filePath)) return;
    const text = await readFile(filePath, "utf8");
    this.transport.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileUri(filePath),
        languageId,
        version: 1,
        text,
      },
    });
    this.openedFiles.add(filePath);
  }

  async send(method: string, params: unknown): Promise<unknown> {
    await this.ready();
    this.touch();
    return this.transport.send(method, params);
  }

  async dispose(): Promise<void> {
    try {
      await this.transport.send("shutdown", null);
      this.transport.notify("exit", null);
    } catch {
      // best-effort: server may already be dead
    }
    await this.transport.dispose();
  }
}

function pathToFileUri(path: string): string {
  return `file://${path.replace(/\\/g, "/")}`;
}
