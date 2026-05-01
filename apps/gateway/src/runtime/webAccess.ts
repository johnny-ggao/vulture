import { ToolCallError } from "@vulture/agent-runtime";
import type { AppError } from "@vulture/protocol/src/v1/error";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TEXT_BYTES = 256_000;

export interface WebSearchRequest {
  query: string;
  limit?: number | null;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchResponse {
  query: string;
  provider: string;
  results: WebSearchResult[];
}

export interface WebFetchRequest {
  url: unknown;
  maxBytes?: number | null;
  approvalToken?: string;
}

export interface WebFetchResponse {
  url: string;
  status: number;
  contentType: string;
  content: string;
  truncated: boolean;
}

export type WebUrlClassification =
  | { ok: true; url: string; isPrivate: boolean; hostname: string }
  | { ok: false; code: AppError["code"]; message: string };

export interface SearchProvider {
  readonly id: string;
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
}

export interface SearchProviderSettings {
  provider: "duckduckgo-html" | "searxng";
  searxngBaseUrl: string | null;
}

export interface WebAccessService {
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
  fetch(request: WebFetchRequest): Promise<WebFetchResponse>;
  classifyUrl(value: unknown): WebUrlClassification;
}

export interface WebAccessServiceOptions {
  fetch: FetchLike;
  searchProvider?: SearchProvider;
  resolveSearchProvider?: (ctx: { fetch: FetchLike }) => SearchProvider | null;
  timeoutMs?: number;
  maxTextBytes?: number;
}

export function createWebAccessService(options: WebAccessServiceOptions): WebAccessService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  const fetchWithTimeout = (input: RequestInfo | URL, init?: RequestInit) =>
    runFetchWithTimeout(options.fetch, input, init, timeoutMs);
  const fallbackSearchProvider =
    options.searchProvider ?? new DuckDuckGoHtmlSearchProvider(fetchWithTimeout);

  return {
    classifyUrl,
    search: async (request) => {
      const provider = options.resolveSearchProvider?.({ fetch: fetchWithTimeout }) ??
        fallbackSearchProvider;
      return provider.search(request);
    },
    fetch: async (request) => {
      const classified = classifyUrl(request.url);
      if (!classified.ok) {
        throw new ToolCallError(classified.code, classified.message);
      }
      if (classified.isPrivate && !request.approvalToken) {
        throw new ToolCallError(
          "tool.permission_denied",
          "web_fetch private host requires approval",
        );
      }

      const response = await fetchWithTimeout(classified.url);
      const text = await response.text();
      const limit =
        typeof request.maxBytes === "number" && request.maxBytes > 0
          ? request.maxBytes
          : maxTextBytes;
      const content = truncateUtf8(text, limit);
      return {
        url: classified.url,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        content,
        truncated: Buffer.byteLength(text) > limit,
      };
    },
  };
}

export class DuckDuckGoHtmlSearchProvider implements SearchProvider {
  readonly id = "duckduckgo-html";

  constructor(private readonly fetch: FetchLike) {}

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    if (typeof request.query !== "string" || request.query.trim().length === 0) {
      throw new ToolCallError("tool.execution_failed", "web_search missing query");
    }
    const limit = clampLimit(request.limit);
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`;
    const response = await this.fetch(url, {
      headers: { "User-Agent": "Vulture/1.0" },
    });
    const html = await response.text();
    return {
      query: request.query,
      provider: this.id,
      results: parseDuckDuckGoResults(html).slice(0, limit),
    };
  }
}

export class SearxngSearchProvider implements SearchProvider {
  readonly id = "searxng";
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(opts: { baseUrl: string; fetch: FetchLike }) {
    this.baseUrl = normalizeHttpBaseUrl(opts.baseUrl, "SearXNG base URL");
    this.fetch = opts.fetch;
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    if (typeof request.query !== "string" || request.query.trim().length === 0) {
      throw new ToolCallError("tool.execution_failed", "web_search missing query");
    }
    const limit = clampLimit(request.limit);
    const url = new URL("search", this.baseUrl);
    url.searchParams.set("q", request.query);
    url.searchParams.set("format", "json");
    const response = await this.fetch(url.toString(), {
      headers: { "User-Agent": "Vulture/1.0", Accept: "application/json" },
    });
    const payload = await response.json().catch(() => {
      throw new ToolCallError("tool.execution_failed", "web_search invalid SearXNG response");
    });
    return {
      query: request.query,
      provider: this.id,
      results: parseSearxngResults(payload).slice(0, limit),
    };
  }
}

export function searchProviderFromSettings(
  settings: SearchProviderSettings,
  fetch: FetchLike,
): SearchProvider | null {
  if (settings.provider !== "searxng") return null;
  if (!settings.searxngBaseUrl) return null;
  return new SearxngSearchProvider({ baseUrl: settings.searxngBaseUrl, fetch });
}

export function classifyUrl(value: unknown): WebUrlClassification {
  if (typeof value !== "string") {
    return { ok: false, code: "tool.execution_failed", message: "web_fetch missing url" };
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        ok: false,
        code: "tool.permission_denied",
        message: "web_fetch requires http(s)",
      };
    }
    return {
      ok: true,
      url: url.toString(),
      hostname: url.hostname,
      isPrivate: isPrivateHostname(url.hostname),
    };
  } catch {
    return { ok: false, code: "tool.execution_failed", message: "web_fetch invalid url" };
  }
}

async function runFetchWithTimeout(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const toolName = String(input).includes("duckduckgo.com/html/") ? "web_search" : "web_fetch";
      throw new ToolCallError("tool.execution_failed", `${toolName} timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function clampLimit(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(Math.trunc(value), 10));
}

function normalizeHttpBaseUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ToolCallError("tool.execution_failed", `${label} is invalid`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolCallError("tool.permission_denied", `${label} must be http(s)`);
  }
  return url.toString();
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  return buffer.byteLength <= maxBytes ? value : buffer.subarray(0, maxBytes).toString("utf8");
}

function parseDuckDuckGoResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const pattern = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  for (const match of html.matchAll(pattern)) {
    const url = normalizeDuckDuckGoUrl(decodeHtml(match[1] ?? ""));
    const title = decodeHtml(stripTags(match[2] ?? "")).trim();
    if (url && title) results.push({ title, url });
  }
  return results;
}

function parseSearxngResults(payload: unknown): WebSearchResult[] {
  const value = isRecord(payload) ? payload : {};
  const results = Array.isArray(value.results) ? value.results : [];
  return results.flatMap((item): WebSearchResult[] => {
    if (!isRecord(item)) return [];
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    const snippet = typeof item.content === "string" ? item.content.trim() : "";
    if (!title || !url) return [];
    return [{ title, url, ...(snippet ? { snippet } : {}) }];
  });
}

function normalizeDuckDuckGoUrl(value: string): string {
  if (!value.includes("duckduckgo.com/l/?") && !value.startsWith("/l/?")) return value;
  try {
    return new URL(value, "https://duckduckgo.com").searchParams.get("uddg") ?? value;
  } catch {
    return value;
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
