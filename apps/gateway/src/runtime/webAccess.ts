import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
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

export interface WebExtractRequest {
  url: unknown;
  maxBytes?: number | null;
  maxLinks?: number | null;
  approvalToken?: string;
}

export interface WebExtractLink {
  text: string;
  url: string;
}

export interface WebExtractResponse {
  url: string;
  status: number;
  contentType: string;
  title: string | null;
  description: string | null;
  text: string;
  links: WebExtractLink[];
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
  extract(request: WebExtractRequest): Promise<WebExtractResponse>;
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
    options.searchProvider ?? createDefaultFallbackSearchProvider(fetchWithTimeout);

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
    extract: async (request) => {
      const classified = classifyUrl(request.url);
      if (!classified.ok) {
        throw new ToolCallError(classified.code, classified.message);
      }
      if (classified.isPrivate && !request.approvalToken) {
        throw new ToolCallError(
          "tool.permission_denied",
          "web_extract private host requires approval",
        );
      }

      const response = await fetchWithTimeout(classified.url);
      const raw = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const limit =
        typeof request.maxBytes === "number" && request.maxBytes > 0
          ? request.maxBytes
          : maxTextBytes;
      const maxLinks =
        typeof request.maxLinks === "number" && request.maxLinks >= 0
          ? Math.min(Math.trunc(request.maxLinks), 100)
          : 30;
      const extracted = contentType.toLowerCase().includes("html")
        ? extractHtml(raw, classified.url, maxLinks)
        : {
            title: null,
            description: null,
            text: normalizeWhitespace(raw),
            links: [] as WebExtractLink[],
          };
      const text = truncateUtf8(extracted.text, limit);
      return {
        url: classified.url,
        status: response.status,
        contentType,
        title: extracted.title,
        description: extracted.description,
        text,
        links: extracted.links,
        truncated: Buffer.byteLength(extracted.text) > limit,
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

export class BingHtmlSearchProvider implements SearchProvider {
  readonly id = "bing-html";

  constructor(private readonly fetch: FetchLike) {}

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    if (typeof request.query !== "string" || request.query.trim().length === 0) {
      throw new ToolCallError("tool.execution_failed", "web_search missing query");
    }
    const limit = clampLimit(request.limit);
    const url = `https://www.bing.com/search?q=${encodeURIComponent(request.query).replace(/%20/g, "+")}`;
    const response = await this.fetch(url, {
      headers: { "User-Agent": "Vulture/1.0" },
    });
    const html = await response.text();
    return {
      query: request.query,
      provider: this.id,
      results: parseBingResults(html).slice(0, limit),
    };
  }
}

export class BraveHtmlSearchProvider implements SearchProvider {
  readonly id = "brave-html";

  constructor(private readonly fetch: FetchLike) {}

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    if (typeof request.query !== "string" || request.query.trim().length === 0) {
      throw new ToolCallError("tool.execution_failed", "web_search missing query");
    }
    const limit = clampLimit(request.limit);
    const url = `https://search.brave.com/search?q=${encodeURIComponent(request.query).replace(/%20/g, "+")}`;
    const response = await this.fetch(url, {
      headers: { "User-Agent": "Vulture/1.0" },
    });
    const html = await response.text();
    return {
      query: request.query,
      provider: this.id,
      results: parseBraveResults(html).slice(0, limit),
    };
  }
}

export function createFallbackSearchProvider(providers: readonly SearchProvider[]): SearchProvider {
  if (providers.length === 0) {
    throw new Error("createFallbackSearchProvider requires at least one provider");
  }
  return {
    id: "fallback",
    async search(request: WebSearchRequest): Promise<WebSearchResponse> {
      const errors: string[] = [];
      for (const provider of providers) {
        try {
          const result = await provider.search(request);
          if (result.results.length > 0) return result;
          errors.push(`${provider.id}: empty`);
        } catch (cause) {
          errors.push(`${provider.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      throw new ToolCallError(
        "tool.execution_failed",
        `web_search exhausted all providers (${errors.join("; ")})`,
      );
    },
  };
}

export function createDefaultFallbackSearchProvider(fetch: FetchLike): SearchProvider {
  return createFallbackSearchProvider([
    new DuckDuckGoHtmlSearchProvider(fetch),
    new BingHtmlSearchProvider(fetch),
    new BraveHtmlSearchProvider(fetch),
  ]);
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

function parseBingResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockPattern = /<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  for (const block of html.matchAll(blockPattern)) {
    const inner = block[1] ?? "";
    const headingMatch = inner.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    if (!headingMatch) continue;
    const linkMatch = headingMatch[1].match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = decodeHtml(linkMatch[1] ?? "").trim();
    const title = decodeHtml(stripTags(linkMatch[2] ?? "")).trim();
    if (!url || !title) continue;
    const snippet = extractBingSnippet(inner);
    results.push(snippet ? { title, url, snippet } : { title, url });
  }
  return results;
}

function extractBingSnippet(blockHtml: string): string | undefined {
  const captionMatch = blockHtml.match(
    /<div\b[^>]*class=["'][^"']*\bb_caption\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  const candidate = captionMatch?.[1] ?? blockHtml;
  const pMatch = candidate.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!pMatch) return undefined;
  const text = normalizeWhitespace(decodeHtml(stripTags(pMatch[1] ?? "")));
  return text.length > 0 ? text : undefined;
}

function parseBraveResults(html: string): WebSearchResult[] {
  // Match "snippet" as a whole class token (not e.g. "snippet-description").
  const SNIPPET_OPEN = /<div\b[^>]*\bclass=["'](?:[^"']*\s)?snippet(?:\s[^"']*)?["'][^>]*>/i;
  const SNIPPET_OPEN_GLOBAL = new RegExp(SNIPPET_OPEN.source, "gi");
  const blockStarts: number[] = [];
  for (const match of html.matchAll(SNIPPET_OPEN_GLOBAL)) {
    if (match.index !== undefined) blockStarts.push(match.index);
  }
  const results: WebSearchResult[] = [];
  for (let i = 0; i < blockStarts.length; i += 1) {
    const start = blockStarts[i];
    const end = blockStarts[i + 1] ?? html.length;
    const inner = html.slice(start, end);
    const linkMatch = inner.match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = decodeHtml(linkMatch[1] ?? "").trim();
    const titleHtml = linkMatch[2] ?? "";
    const titleMatch = titleHtml.match(
      /<(?:div|span)\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i,
    );
    const titleSource = titleMatch?.[1] ?? titleHtml;
    const title = decodeHtml(stripTags(titleSource)).trim();
    if (!url || !title) continue;
    const descMatch = inner.match(
      /<div\b[^>]*\bclass=["'][^"']*\bsnippet-description\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );
    const snippet = descMatch
      ? normalizeWhitespace(decodeHtml(stripTags(descMatch[1] ?? "")))
      : "";
    results.push(snippet ? { title, url, snippet } : { title, url });
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

function extractHtml(
  html: string,
  baseUrl: string,
  maxLinks: number,
): {
  title: string | null;
  description: string | null;
  text: string;
  links: WebExtractLink[];
} {
  const metadataDoc = parseHTML(html).document;
  const title = readMetadataTitle(metadataDoc);
  const description = readMetadataDescription(metadataDoc);
  const links = collectDocumentLinks(metadataDoc, baseUrl, maxLinks);
  const text = readReadableText(html);
  return { title, description, text, links };
}

function readMetadataTitle(doc: Document): string | null {
  const value = doc.querySelector("title")?.textContent ?? "";
  const trimmed = decodeHtml(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readMetadataDescription(doc: Document): string | null {
  const meta = doc.querySelector('meta[name="description" i]');
  const value = meta?.getAttribute("content") ?? "";
  const trimmed = decodeHtml(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collectDocumentLinks(doc: Document, baseUrl: string, maxLinks: number): WebExtractLink[] {
  const links: WebExtractLink[] = [];
  const seen = new Set<string>();
  const anchors = doc.querySelectorAll("a[href]");
  for (const anchor of anchors) {
    if (links.length >= maxLinks) break;
    const href = decodeHtml(anchor.getAttribute("href") ?? "").trim();
    const text = normalizeWhitespace(anchor.textContent ?? "");
    const url = normalizeExtractedUrl(href, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ text, url });
  }
  return links;
}

function readReadableText(html: string): string {
  const stripped = stripNonContentElements(html);
  if (stripped.length > 0) return stripped;
  return readabilityFallback(html);
}

function stripNonContentElements(html: string): string {
  const { document } = parseHTML(html);
  for (const selector of ["script", "style", "noscript", "nav", "header", "footer", "aside", "head"]) {
    for (const el of document.querySelectorAll(selector)) {
      el.remove();
    }
  }
  const body = document.body ?? document.documentElement;
  if (!body) return "";
  // Replace tags with spaces so block-level boundaries stay separated in text output.
  const text = (body.innerHTML ?? "").replace(/<[^>]+>/g, " ");
  return normalizeWhitespace(decodeHtml(text));
}

function readabilityFallback(html: string): string {
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document as unknown as globalThis.Document, {
      charThreshold: 0,
    });
    const article = reader.parse();
    if (article?.textContent) {
      return normalizeWhitespace(article.textContent);
    }
  } catch {
    // fall through to empty string; caller decides default
  }
  return "";
}

function normalizeExtractedUrl(value: string, baseUrl: string): string | null {
  if (!value || value.startsWith("#")) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
