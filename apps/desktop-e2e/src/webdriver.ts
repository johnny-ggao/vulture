const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const NO_SESSION_ERROR = "WebDriver session has not been created. Call createSession() first.";

type FetchLike = typeof fetch;

interface WebDriverEnvelope<T> {
  sessionId?: unknown;
  value: T;
}

export class WebDriverClient {
  #sessionId: string | null = null;
  #fetch: FetchLike;
  #baseUrl: string;

  constructor(baseUrl: string, fetchImpl: FetchLike = fetch) {
    this.#baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.#fetch = fetchImpl;
  }

  async createSession(alwaysMatch: Record<string, unknown> = {}): Promise<string> {
    const envelope = await this.#requestEnvelope<{
      sessionId?: unknown;
      capabilities?: unknown;
    }>("POST", "session", {
      capabilities: {
        alwaysMatch,
        firstMatch: [{}],
      },
    });

    const sessionId = extractSessionId(envelope);
    if (!sessionId) {
      throw new Error("WebDriver createSession response missing sessionId");
    }

    this.#sessionId = sessionId;
    return sessionId;
  }

  async findElement(using: string, value: string): Promise<string> {
    const result = await this.#sessionRequest<Record<string, unknown>>("POST", "element", {
      using,
      value,
    });
    const elementId = extractElementId(result);
    if (!elementId) {
      throw new Error("WebDriver findElement response missing element id");
    }
    return elementId;
  }

  async click(elementId: string): Promise<void> {
    await this.#sessionRequest("POST", `element/${encodeURIComponent(elementId)}/click`, {});
  }

  async type(elementId: string, text: string): Promise<void> {
    await this.#sessionRequest("POST", `element/${encodeURIComponent(elementId)}/value`, {
      text,
      value: Array.from(text),
    });
  }

  async screenshot(): Promise<Buffer> {
    const value = await this.#sessionRequest<unknown>("GET", "screenshot");
    if (typeof value !== "string") {
      throw new Error("WebDriver screenshot response must be a base64 string");
    }
    return Buffer.from(value, "base64");
  }

  async pageSource(): Promise<string> {
    const value = await this.#sessionRequest<unknown>("GET", "source");
    if (typeof value !== "string") {
      throw new Error("WebDriver pageSource response must be a string");
    }
    return value;
  }

  async deleteSession(): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId) {
      return;
    }

    try {
      await this.#requestValue("DELETE", `session/${encodeURIComponent(sessionId)}`);
    } finally {
      if (this.#sessionId === sessionId) {
        this.#sessionId = null;
      }
    }
  }

  async #sessionRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const sessionId = this.#sessionId;
    if (!sessionId) {
      throw new Error(NO_SESSION_ERROR);
    }
    return await this.#requestValue<T>(method, `session/${encodeURIComponent(sessionId)}/${path}`, body);
  }

  async #requestValue<T>(method: string, path: string, body?: unknown): Promise<T> {
    const envelope = await this.#requestEnvelope<T>(method, path, body);
    return envelope.value;
  }

  async #requestEnvelope<T>(method: string, path: string, body?: unknown): Promise<WebDriverEnvelope<T>> {
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    const payload = parseJson(text);

    if (!response.ok) {
      throw new Error(extractErrorMessage(payload, text, response.status, response.statusText));
    }

    if (!payload || typeof payload !== "object" || !("value" in payload)) {
      throw new Error("WebDriver response missing value payload");
    }

    return payload as WebDriverEnvelope<T>;
  }
}

function extractSessionId(
  envelope: WebDriverEnvelope<{ sessionId?: unknown }> | null | undefined,
): string | null {
  if (typeof envelope?.sessionId === "string" && envelope.sessionId.length > 0) {
    return envelope.sessionId;
  }

  const nestedSessionId = envelope?.value?.sessionId;
  return typeof nestedSessionId === "string" && nestedSessionId.length > 0 ? nestedSessionId : null;
}

function extractElementId(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const w3cId = value[ELEMENT_KEY];
  if (typeof w3cId === "string" && w3cId.length > 0) {
    return w3cId;
  }

  const legacyId = value.ELEMENT;
  return typeof legacyId === "string" && legacyId.length > 0 ? legacyId : null;
}

function parseJson(text: string): unknown {
  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractErrorMessage(payload: unknown, text: string, status: number, statusText: string): string {
  if (payload && typeof payload === "object") {
    const value = "value" in payload ? payload.value : payload;
    if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
      return value.message;
    }

    return statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
  }

  const trimmed = text.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  return statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
}
