import { parseGatewayEnv } from "./env";
import { buildServer } from "./server";
import { startWatchdog } from "./runtime/watchdog";

async function main() {
  const cfg = parseGatewayEnv(
    process.env as Record<string, string | undefined>,
  );
  const app = buildServer(cfg);

  // SECURITY: bind 127.0.0.1 only.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    fetch: app.fetch,
  });

  startWatchdog({ pid: cfg.shellPid });

  // READY handshake: Tauri parent reads stdout for this exact format.
  console.log(`READY ${server.port}`);
}

main().catch((err) => {
  console.error("gateway fatal:", err);
  process.exit(1);
});
