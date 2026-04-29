export interface RuntimeBase {
  gateway: { port: number };
  token: string;
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  baseHost?: string;
}

export interface ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
}

export interface ApiClient {
  readonly base: string;
  readonly token: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  postForm<T>(path: string, form: FormData): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

function newId(): string {
  return crypto.randomUUID();
}

export function createApiClient(rt: RuntimeBase, opts: ApiClientOptions = {}): ApiClient {
  const f = opts.fetch ?? fetch;
  const host = opts.baseHost ?? "127.0.0.1";
  const base = `http://${host}:${rt.gateway.port}`;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${rt.token}`,
      "X-Request-Id": newId(),
    };
    const init: RequestInit = { method, headers };
    if (method === "POST" || method === "PATCH" || method === "PUT") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }
    if (method === "POST") {
      headers["Idempotency-Key"] = newId();
    }
    const res = await f(`${base}${path}`, init);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const err: ApiError = Object.assign(
        new Error(errBody?.message ?? `${method} ${path} -> HTTP ${res.status}`),
        {
          code: errBody?.code ?? "internal",
          status: res.status,
          details: errBody?.details,
        },
      );
      throw err;
    }
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  }

  async function requestForm<T>(path: string, form: FormData): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${rt.token}`,
      "X-Request-Id": newId(),
      "Idempotency-Key": newId(),
    };
    const res = await f(`${base}${path}`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const err: ApiError = Object.assign(
        new Error(errBody?.message ?? `POST ${path} -> HTTP ${res.status}`),
        {
          code: errBody?.code ?? "internal",
          status: res.status,
          details: errBody?.details,
        },
      );
      throw err;
    }
    return (await res.json()) as T;
  }

  return {
    base,
    token: rt.token,
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
    postForm: <T>(path: string, form: FormData) => requestForm<T>(path, form),
    put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
    patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
    delete: (path: string) => request<void>("DELETE", path),
  };
}
