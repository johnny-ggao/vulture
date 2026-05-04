/**
 * Lightweight per-provider connectivity probe. Each probe hits an auth-validated
 * endpoint that does NOT consume LLM tokens (typically `/models` listings) so
 * the user can verify their saved key works without paying for inference.
 *
 * The probe trusts the caller to have already resolved the credential via
 * `resolveRuntimeModelProvider`; this module is a pure HTTP smoke test.
 */

export type ModelConnectivityFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ModelConnectivityProbeInput {
  provider: string;
  model: string;
  apiKey: string;
  fetch?: ModelConnectivityFetch;
  timeoutMs?: number;
}

export interface ModelConnectivityProbeOutput {
  ok: boolean;
  /** Provider-specific status text (e.g. number of models visible to the key). */
  message: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function probeModelConnectivity(
  input: ModelConnectivityProbeInput,
): Promise<ModelConnectivityProbeOutput> {
  const fetchImpl = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  switch (input.provider) {
    case "openai":
      return probeOpenAi({ apiKey: input.apiKey, fetch: fetchImpl, timeoutMs });
    case "anthropic":
      return probeAnthropic({ apiKey: input.apiKey, fetch: fetchImpl, timeoutMs });
    case "google":
      return probeGemini({ apiKey: input.apiKey, fetch: fetchImpl, timeoutMs });
    default:
      return {
        ok: false,
        message: `Provider "${input.provider}" connectivity probe not implemented yet.`,
      };
  }
}

interface ProbeArgs {
  apiKey: string;
  fetch: ModelConnectivityFetch;
  timeoutMs: number;
}

async function probeOpenAi(opts: ProbeArgs): Promise<ModelConnectivityProbeOutput> {
  const response = await fetchWithTimeout(
    opts.fetch,
    "https://api.openai.com/v1/models",
    {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: "application/json",
        "User-Agent": "Vulture/1.0",
      },
    },
    opts.timeoutMs,
  );
  if (!response.ok) {
    return failureFromResponse("OpenAI", response);
  }
  const count = await readModelCount(response, (payload) => {
    const value = isRecord(payload) ? payload : {};
    return Array.isArray(value.data) ? value.data.length : 0;
  });
  return { ok: true, message: `OpenAI auth ok · ${count} 个模型可见` };
}

async function probeAnthropic(opts: ProbeArgs): Promise<ModelConnectivityProbeOutput> {
  const response = await fetchWithTimeout(
    opts.fetch,
    "https://api.anthropic.com/v1/models",
    {
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
        "User-Agent": "Vulture/1.0",
      },
    },
    opts.timeoutMs,
  );
  if (!response.ok) {
    return failureFromResponse("Anthropic", response);
  }
  const count = await readModelCount(response, (payload) => {
    const value = isRecord(payload) ? payload : {};
    return Array.isArray(value.data) ? value.data.length : 0;
  });
  return { ok: true, message: `Anthropic auth ok · ${count} 个模型可见` };
}

async function probeGemini(opts: ProbeArgs): Promise<ModelConnectivityProbeOutput> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(opts.apiKey)}`;
  const response = await fetchWithTimeout(
    opts.fetch,
    url,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "Vulture/1.0",
      },
    },
    opts.timeoutMs,
  );
  if (!response.ok) {
    return failureFromResponse("Gemini", response);
  }
  const count = await readModelCount(response, (payload) => {
    const value = isRecord(payload) ? payload : {};
    return Array.isArray(value.models) ? value.models.length : 0;
  });
  return { ok: true, message: `Gemini auth ok · ${count} 个模型可见` };
}

async function fetchWithTimeout(
  fetchImpl: ModelConnectivityFetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(handle);
  }
}

async function failureFromResponse(
  label: string,
  response: Response,
): Promise<ModelConnectivityProbeOutput> {
  const detail = await readErrorDetail(response);
  return {
    ok: false,
    message: `${label} 连通失败 (HTTP ${response.status}${detail ? ": " + detail : ""})`,
  };
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text);
      const error = isRecord(parsed) ? parsed.error : null;
      if (typeof error === "string") return error;
      if (isRecord(error) && typeof error.message === "string") return error.message;
      if (isRecord(parsed) && typeof parsed.message === "string") return parsed.message;
    } catch {
      // not JSON, fall through to plain text
    }
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

async function readModelCount(
  response: Response,
  countFromPayload: (payload: unknown) => number,
): Promise<number> {
  try {
    const payload = await response.json();
    return countFromPayload(payload);
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
