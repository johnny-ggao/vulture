import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { readJsonFile, writeJsonFile } from "./jsonFileStore";

export type WebSearchProviderId = "duckduckgo-html" | "searxng";

export interface WebSearchSettings {
  provider: WebSearchProviderId;
  searxngBaseUrl: string | null;
  updatedAt: Iso8601;
}

export interface UpdateWebSearchSettingsInput {
  provider?: WebSearchProviderId;
  searxngBaseUrl?: string | null;
}

interface WebSearchSettingsFile {
  schemaVersion: 1;
  settings: WebSearchSettings;
}

const DEFAULT_SETTINGS: WebSearchSettings = {
  provider: "duckduckgo-html",
  searxngBaseUrl: null,
  updatedAt: "1970-01-01T00:00:00.000Z" as Iso8601,
};

const DEFAULT_FILE: WebSearchSettingsFile = {
  schemaVersion: 1,
  settings: DEFAULT_SETTINGS,
};

export class WebSearchSettingsStore {
  constructor(private readonly path: string) {}

  get(): WebSearchSettings {
    return this.read().settings;
  }

  update(input: UpdateWebSearchSettingsInput): WebSearchSettings {
    const current = this.get();
    const next = normalizeSettings({
      ...current,
      ...input,
      updatedAt: nowIso8601(),
    });
    this.write({ schemaVersion: 1, settings: next });
    return next;
  }

  private read(): WebSearchSettingsFile {
    const parsed = readJsonFile<WebSearchSettingsFile>(this.path, DEFAULT_FILE);
    if (parsed.schemaVersion !== 1 || !isSettings(parsed.settings)) return DEFAULT_FILE;
    try {
      return {
        schemaVersion: 1,
        settings: normalizeSettings(parsed.settings),
      };
    } catch {
      return DEFAULT_FILE;
    }
  }

  private write(file: WebSearchSettingsFile): void {
    writeJsonFile(this.path, file);
  }
}

export function normalizeSettings(input: WebSearchSettings): WebSearchSettings {
  if (input.provider !== "duckduckgo-html" && input.provider !== "searxng") {
    throw new Error("provider is invalid");
  }
  const searxngBaseUrl = normalizeBaseUrl(input.searxngBaseUrl);
  if (input.provider === "searxng" && !searxngBaseUrl) {
    throw new Error("searxngBaseUrl is required");
  }
  return {
    provider: input.provider,
    searxngBaseUrl,
    updatedAt: input.updatedAt,
  };
}

function normalizeBaseUrl(value: string | null): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("searxngBaseUrl is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("searxngBaseUrl must be http(s)");
  }
  return url.toString();
}

function isSettings(value: unknown): value is WebSearchSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<WebSearchSettings>;
  return (
    (settings.provider === "duckduckgo-html" || settings.provider === "searxng") &&
    (typeof settings.searxngBaseUrl === "string" || settings.searxngBaseUrl === null) &&
    typeof settings.updatedAt === "string"
  );
}
