import type { ModelProvider } from "@openai/agents";
import type { AuthProfileView } from "@vulture/protocol/src/v1/modelConfig";
import { fetchShellModelAuthSnapshot } from "../domain/modelAuth";
import { fetchCodexToken, makeCodexModelProvider, type CodexShellError } from "./codexLlm";
import { parseModelRefWithProfile, type ParsedModelRef } from "./modelRef";
import { makeResponsesModelProvider } from "./openaiLlm";

export type RuntimeModelProviderResolution =
  | {
      kind: "provider";
      provider: string;
      model: string;
      profileId: string;
      apiKey: string;
      modelProvider: ModelProvider;
    }
  | {
      kind: "error";
      provider: string;
      model: string;
      profileId?: string;
      message: string;
    };

export interface ResolveRuntimeModelProviderOptions {
  modelRef: string;
  env?: Record<string, string | undefined>;
  shellCallbackUrl: string;
  shellToken: string;
  fetch?: typeof fetch;
  runId?: string;
}

export async function resolveRuntimeModelProvider(
  opts: ResolveRuntimeModelProviderOptions,
): Promise<RuntimeModelProviderResolution> {
  const parsed = parseModelRefWithProfile(opts.modelRef);
  if (!parsed) {
    return {
      kind: "error",
      provider: "unknown",
      model: opts.modelRef,
      message: `Invalid model reference: ${opts.modelRef}`,
    };
  }

  const env = opts.env ?? process.env;
  const shellAuth = await fetchShellModelAuthSnapshot({
    shellCallbackUrl: opts.shellCallbackUrl,
    shellToken: opts.shellToken,
    fetch: opts.fetch,
  });
  const profiles = mergeProfiles(shellAuth.profiles, envAuthProfiles(env));
  const profileOrder = authOrderForParsed(parsed, profiles, shellAuth.authOrder);

  for (const profileId of profileOrder) {
    const profile = profiles.get(profileId);
    if (!profile || profile.provider !== parsed.provider) {
      if (parsed.explicitProfile) return missingProfileError(parsed, profileId);
      continue;
    }

    const result = await resolveProfile({
      parsed,
      profile,
      env,
      shellCallbackUrl: opts.shellCallbackUrl,
      shellToken: opts.shellToken,
      fetch: opts.fetch,
      runId: opts.runId,
    });
    if (result.kind === "provider") return result;
    if (parsed.explicitProfile || shouldStopOnError(result)) return result;
  }

  return defaultMissingAuthError(parsed);
}

function envAuthProfiles(env: Record<string, string | undefined>): AuthProfileView[] {
  return [
    {
      id: "openai-api-key",
      provider: "openai",
      mode: "api_key",
      label: "OpenAI API Key",
      status: env.OPENAI_API_KEY ? "configured" : "missing",
    },
    {
      id: "anthropic-api-key",
      provider: "anthropic",
      mode: "api_key",
      label: "Anthropic API Key",
      status: env.ANTHROPIC_API_KEY ? "configured" : "missing",
    },
  ];
}

function mergeProfiles(
  shellProfiles: AuthProfileView[],
  envProfiles: AuthProfileView[],
): Map<string, AuthProfileView> {
  const profiles = new Map<string, AuthProfileView>();
  for (const profile of [...shellProfiles, ...envProfiles]) {
    profiles.set(profile.id, profile);
  }
  return profiles;
}

function authOrderForParsed(
  parsed: ParsedModelRef,
  profiles: Map<string, AuthProfileView>,
  shellAuthOrder: Record<string, string[]>,
): string[] {
  if (parsed.explicitProfile) return parsed.profileId ? [parsed.profileId] : [];

  if (parsed.provider === "openai") {
    const shellOrder = shellAuthOrder.openai;
    if (shellOrder) return appendIfMissing(shellOrder, "openai-api-key");
    const codex = profiles.get("codex");
    return codex?.provider === "openai" && codex.status === "configured"
      ? ["codex", "openai-api-key"]
      : ["openai-api-key"];
  }

  if (parsed.provider === "anthropic") {
    const shellOrder = shellAuthOrder.anthropic;
    return appendIfMissing(shellOrder ?? [], "anthropic-api-key");
  }

  return shellAuthOrder[parsed.provider] ?? [];
}

function appendIfMissing(order: string[], id: string): string[] {
  return order.includes(id) ? order : [...order, id];
}

async function resolveProfile(opts: {
  parsed: ParsedModelRef;
  profile: AuthProfileView;
  env: Record<string, string | undefined>;
  shellCallbackUrl: string;
  shellToken: string;
  fetch?: typeof fetch;
  runId?: string;
}): Promise<RuntimeModelProviderResolution> {
  if (opts.profile.id === "codex" && opts.parsed.provider === "openai") {
    return resolveCodexProfile(opts);
  }

  if (opts.profile.id === "openai-api-key" && opts.parsed.provider === "openai") {
    const apiKey = opts.env.OPENAI_API_KEY;
    if (!apiKey) {
      return errorForProfile(
        opts.parsed,
        opts.profile.id,
        "OPENAI_API_KEY not configured. Set the key via Settings or set the env var, then retry.",
      );
    }
    return {
      kind: "provider",
      provider: opts.parsed.provider,
      model: opts.parsed.model,
      profileId: opts.profile.id,
      apiKey,
      modelProvider: makeResponsesModelProvider({ apiKey }),
    };
  }

  if (opts.profile.id === "anthropic-api-key" && opts.parsed.provider === "anthropic") {
    const apiKey = opts.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return errorForProfile(
        opts.parsed,
        opts.profile.id,
        "Anthropic API key is not configured. Set ANTHROPIC_API_KEY, then retry.",
      );
    }
    return errorForProfile(
      opts.parsed,
      opts.profile.id,
      "Anthropic runtime adapter is not available yet.",
    );
  }

  return errorForProfile(
    opts.parsed,
    opts.profile.id,
    `${opts.profile.label} is not supported by the gateway runtime yet.`,
  );
}

async function resolveCodexProfile(opts: {
  parsed: ParsedModelRef;
  profile: AuthProfileView;
  shellCallbackUrl: string;
  shellToken: string;
  fetch?: typeof fetch;
  runId?: string;
}): Promise<RuntimeModelProviderResolution> {
  try {
    const token = await fetchCodexToken({
      shellUrl: opts.shellCallbackUrl,
      bearer: opts.shellToken,
      fetch: opts.fetch,
    });
    return {
      kind: "provider",
      provider: opts.parsed.provider,
      model: opts.parsed.model,
      profileId: opts.profile.id,
      apiKey: token.accessToken,
      modelProvider: makeCodexModelProvider({
        token,
        fetch: opts.fetch,
        runId: opts.runId,
      }),
    };
  } catch (cause) {
    const err = cause as CodexShellError;
    const message =
      err.code === "auth.codex_expired"
        ? "Codex OpenAI authentication has expired. Sign in with ChatGPT again, then retry."
        : "Codex OpenAI authentication is not available. Sign in with ChatGPT or configure OPENAI_API_KEY, then retry.";
    return errorForProfile(opts.parsed, opts.profile.id, message);
  }
}

function shouldStopOnError(result: RuntimeModelProviderResolution): boolean {
  return (
    result.kind === "error" &&
    result.profileId === "codex" &&
    result.message.includes("expired")
  );
}

function missingProfileError(parsed: ParsedModelRef, profileId: string): RuntimeModelProviderResolution {
  return errorForProfile(
    parsed,
    profileId,
    `Model auth profile "${profileId}" is not available for ${parsed.provider}.`,
  );
}

function defaultMissingAuthError(parsed: ParsedModelRef): RuntimeModelProviderResolution {
  if (parsed.provider === "anthropic") {
    return errorForProfile(
      parsed,
      "anthropic-api-key",
      "Anthropic API key is not configured. Set ANTHROPIC_API_KEY, then retry.",
    );
  }
  if (parsed.provider === "openai") {
    return errorForProfile(
      parsed,
      "openai-api-key",
      "OPENAI_API_KEY not configured. Set the key via Settings or set the env var, then retry.",
    );
  }
  return {
    kind: "error",
    provider: parsed.provider,
    model: parsed.model,
    message: `Provider "${parsed.provider}" is not supported by the gateway runtime yet.`,
  };
}

function errorForProfile(
  parsed: ParsedModelRef,
  profileId: string,
  message: string,
): RuntimeModelProviderResolution {
  return {
    kind: "error",
    provider: parsed.provider,
    model: parsed.model,
    profileId,
    message,
  };
}
