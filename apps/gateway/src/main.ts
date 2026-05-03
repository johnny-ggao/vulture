import { parseGatewayEnv } from "./env";
import { buildServer } from "./server";
import { startWatchdog } from "./runtime/watchdog";
import { createLspClientManager } from "./runtime/lspClientManager";
import { createRealTransport } from "./runtime/lspTransport";

async function main() {
  const cfg = parseGatewayEnv(
    process.env as Record<string, string | undefined>,
  );
  // LSP manager is constructed here (not in buildServer) so tests don't
  // accumulate sweepers / SIGTERM listeners.
  const lspManager = createLspClientManager({
    transportFactory: createRealTransport,
  });
  const app = buildServer({ ...cfg, lspManager });

  // SECURITY: bind 127.0.0.1 only.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    fetch: app.fetch,
  });

  startWatchdog({ pid: cfg.shellPid });

  const onShutdown = async () => {
    try {
      await lspManager.dispose();
    } catch (err) {
      console.error("[gateway] lspManager dispose failed", err);
    }
    process.exit(0);
  };
  process.once("SIGTERM", onShutdown);
  process.once("SIGINT", onShutdown);

  // READY handshake: Tauri parent reads stdout for this exact format.
  console.log(`READY ${server.port}`);
}

main().catch((err) => {
  console.error("gateway fatal:", err);
  process.exit(1);
});
