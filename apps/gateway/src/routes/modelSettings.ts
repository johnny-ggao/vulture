import { Hono } from "hono";
import {
  ModelSettingsResponseSchema,
  type AuthProfileView,
  type ModelProviderView,
} from "@vulture/protocol/src/v1/modelConfig";
import {
  fetchShellModelAuthSnapshot,
  type ModelSettingsFetch,
} from "../domain/modelAuth";
import { baseModelProviders } from "../domain/modelCatalog";

export interface ModelSettingsRouterDeps {
  shellCallbackUrl: string;
  shellToken: string;
  env?: Record<string, string | undefined>;
  fetch?: ModelSettingsFetch;
}

export function modelSettingsRouter(deps: ModelSettingsRouterDeps): Hono {
  const app = new Hono();

  app.get("/v1/model-settings", async (c) => {
    const shellAuth = await fetchShellModelAuthSnapshot({
      shellCallbackUrl: deps.shellCallbackUrl,
      shellToken: deps.shellToken,
      fetch: deps.fetch,
    });
    const response = ModelSettingsResponseSchema.parse({
      providers: mergeProviderAuth({
        providers: baseModelProviders(),
        shellProfiles: shellAuth.profiles,
        shellAuthOrder: shellAuth.authOrder,
        env: deps.env ?? process.env,
      }),
    });
    return c.json(response);
  });

  return app;
}

function mergeProviderAuth(opts: {
  providers: ModelProviderView[];
  shellProfiles: AuthProfileView[];
  shellAuthOrder: Record<string, string[]>;
  env: Record<string, string | undefined>;
}): ModelProviderView[] {
  const envProfiles = envAuthProfiles(opts.env);

  return opts.providers.map((provider) => {
    const authProfiles = mergeProfiles(
      provider.id,
      opts.shellProfiles,
      envProfiles,
      provider.authProfiles,
    );
    return {
      ...provider,
      authProfiles,
      authOrder: authOrderForProvider(provider.id, authProfiles, opts.shellAuthOrder, provider.authOrder),
    };
  });
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
  provider: string,
  shellProfiles: AuthProfileView[],
  envProfiles: AuthProfileView[],
  staticProfiles: AuthProfileView[],
): AuthProfileView[] {
  const byId = new Map<string, AuthProfileView>();
  for (const profile of [...shellProfiles, ...envProfiles, ...staticProfiles]) {
    if (profile.provider === provider && !byId.has(profile.id)) {
      byId.set(profile.id, profile);
    }
  }
  return [...byId.values()];
}

function authOrderForProvider(
  provider: string,
  authProfiles: AuthProfileView[],
  shellAuthOrder: Record<string, string[]>,
  staticAuthOrder: string[],
): string[] {
  if (provider === "openai") {
    return openAiAuthOrder(authProfiles, shellAuthOrder.openai);
  }
  if (provider === "anthropic") {
    return includeKnownProfiles(["anthropic-api-key"], authProfiles);
  }
  return includeKnownProfiles(shellAuthOrder[provider] ?? staticAuthOrder, authProfiles);
}

function openAiAuthOrder(authProfiles: AuthProfileView[], shellOrder?: string[]): string[] {
  if (shellOrder) {
    return includeKnownProfiles(appendIfMissing(shellOrder, "openai-api-key"), authProfiles);
  }

  const configured = authProfiles
    .filter((profile) => profile.status === "configured")
    .map((profile) => profile.id);
  const fallback = authProfiles
    .filter((profile) => profile.status !== "configured")
    .map((profile) => profile.id);
  return includeKnownProfiles([...configured, ...fallback, "openai-api-key"], authProfiles);
}

function appendIfMissing(order: string[], id: string): string[] {
  return order.includes(id) ? order : [...order, id];
}

function includeKnownProfiles(order: string[], authProfiles: AuthProfileView[]): string[] {
  const known = new Set(authProfiles.map((profile) => profile.id));
  const out: string[] = [];
  for (const id of order) {
    if (known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
