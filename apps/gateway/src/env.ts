export interface GatewayConfig {
  port: number;
  token: string;
  shellCallbackUrl: string;
  shellPid: number;
  profileDir: string;
  defaultWorkspace?: string;
}

function required(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const v = env[key];
  if (!v) {
    throw new Error(`${key} env var is required`);
  }
  return v;
}

export function parseGatewayEnv(
  env: Record<string, string | undefined>,
): GatewayConfig {
  const portStr = required(env, "VULTURE_GATEWAY_PORT");
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(
      `VULTURE_GATEWAY_PORT must be a valid port: got ${portStr}`,
    );
  }

  const token = required(env, "VULTURE_GATEWAY_TOKEN");
  if (token.length !== 43) {
    throw new Error(
      `VULTURE_GATEWAY_TOKEN must be 43 chars (32 bytes b64url)`,
    );
  }

  const pidStr = required(env, "VULTURE_SHELL_PID");
  const shellPid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(shellPid) || shellPid < 1) {
    throw new Error(`VULTURE_SHELL_PID must be a positive integer`);
  }

  return {
    port,
    token,
    shellCallbackUrl: required(env, "VULTURE_SHELL_CALLBACK_URL"),
    shellPid,
    profileDir: required(env, "VULTURE_PROFILE_DIR"),
    defaultWorkspace: env.VULTURE_DEFAULT_WORKSPACE,
  };
}
