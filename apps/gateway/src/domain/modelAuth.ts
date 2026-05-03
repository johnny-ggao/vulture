import {
  AuthProfileViewSchema,
  type AuthProfileView,
} from "@vulture/protocol/src/v1/modelConfig";

export interface ModelAuthSnapshot {
  profiles: AuthProfileView[];
  authOrder: Record<string, string[]>;
}

export type ModelSettingsFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

interface ShellModelAuthProfile {
  id?: unknown;
  provider?: unknown;
  mode?: unknown;
  label?: unknown;
  status?: unknown;
  email?: unknown;
  expires_at?: unknown;
  message?: unknown;
}

interface ShellModelAuthResponse {
  profiles?: unknown;
  auth_order?: unknown;
}

interface ShellModelApiKeyResponse {
  api_key?: unknown;
}

const EMPTY_MODEL_AUTH_SNAPSHOT: ModelAuthSnapshot = {
  profiles: [],
  authOrder: {},
};

export async function fetchShellModelAuthSnapshot(opts: {
  shellCallbackUrl: string;
  shellToken: string;
  fetch?: ModelSettingsFetch;
}): Promise<ModelAuthSnapshot> {
  try {
    const fetchImpl = opts.fetch ?? fetch;
    const res = await fetchImpl(`${opts.shellCallbackUrl}/auth/model-profiles`, {
      headers: { Authorization: `Bearer ${opts.shellToken}` },
    });
    if (!res.ok) return EMPTY_MODEL_AUTH_SNAPSHOT;

    const raw = (await res.json()) as ShellModelAuthResponse;
    return {
      profiles: normalizeShellProfiles(raw.profiles),
      authOrder: normalizeShellAuthOrder(raw.auth_order),
    };
  } catch {
    return EMPTY_MODEL_AUTH_SNAPSHOT;
  }
}

export async function fetchShellModelApiKey(opts: {
  shellCallbackUrl: string;
  shellToken: string;
  profileId: string;
  fetch?: ModelSettingsFetch;
}): Promise<string | null> {
  try {
    const fetchImpl = opts.fetch ?? fetch;
    const res = await fetchImpl(
      `${opts.shellCallbackUrl}/auth/model-api-key/${encodeURIComponent(opts.profileId)}`,
      { headers: { Authorization: `Bearer ${opts.shellToken}` } },
    );
    if (!res.ok) return null;

    const raw = (await res.json()) as ShellModelApiKeyResponse;
    return typeof raw.api_key === "string" && raw.api_key.trim() !== ""
      ? raw.api_key
      : null;
  } catch {
    return null;
  }
}

function normalizeShellProfiles(raw: unknown): AuthProfileView[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((profile: ShellModelAuthProfile) => {
    const candidate = {
      id: profile.id,
      provider: profile.provider,
      mode: profile.mode,
      label: profile.label,
      status: profile.status,
      email: profile.email,
      expiresAt: profile.expires_at,
      message: profile.message,
    };
    const parsed = AuthProfileViewSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function normalizeShellAuthOrder(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: Record<string, string[]> = {};
  for (const [provider, order] of Object.entries(raw)) {
    if (!Array.isArray(order)) continue;
    out[provider] = order.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  }
  return out;
}
