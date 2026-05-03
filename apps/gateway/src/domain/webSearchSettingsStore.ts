import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { readJsonFile, writeJsonFile } from "./jsonFileStore";

export type WebSearchProviderId =
  | "multi"
  | "duckduckgo-html"
  | "bing-html"
  | "brave-html"
  | "brave-api"
  | "searxng";

export const WEB_SEARCH_PROVIDER_IDS: readonly WebSearchProviderId[] = [
  "multi",
  "duckduckgo-html",
  "bing-html",
  "brave-html",
  "brave-api",
  "searxng",
];

export interface WebSearchSettings {
  provider: WebSearchProviderId;
  searxngBaseUrl: string | null;
  braveApiKey: string | null;
  updatedAt: Iso8601;
}

export interface UpdateWebSearchSettingsInput {
  provider?: WebSearchProviderId;
  searxngBaseUrl?: string | null;
  braveApiKey?: string | null;
}

interface WebSearchSettingsFile {
  schemaVersion: 1;
  settings: WebSearchSettings;
}

const DEFAULT_SETTINGS: WebSearchSettings = {
  provider: "multi",
  searxngBaseUrl: null,
  braveApiKey: null,
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
  if (!WEB_SEARCH_PROVIDER_IDS.includes(input.provider)) {
    throw new Error("provider is invalid");
  }
  const searxngBaseUrl = normalizeBaseUrl(input.searxngBaseUrl);
  if (input.provider === "searxng" && !searxngBaseUrl) {
    throw new Error("searxngBaseUrl is required");
  }
  const braveApiKey = normalizeApiKey(input.braveApiKey);
  if (input.provider === "brave-api" && !braveApiKey) {
    throw new Error("braveApiKey is required");
  }
  return {
    provider: input.provider,
    searxngBaseUrl,
    braveApiKey,
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

function normalizeApiKey(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function isSettings(value: unknown): value is WebSearchSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<WebSearchSettings> & Record<string, unknown>;
  if (typeof settings.provider !== "string") return false;
  if (!WEB_SEARCH_PROVIDER_IDS.includes(settings.provider as WebSearchProviderId)) return false;
  if (settings.searxngBaseUrl !== null && typeof settings.searxngBaseUrl !== "string") return false;
  if (settings.braveApiKey !== undefined &&
    settings.braveApiKey !== null &&
    typeof settings.braveApiKey !== "string"
  ) return false;
  return typeof settings.updatedAt === "string";
}
