import { Hono } from "hono";
import { join } from "node:path";
import { authMiddleware, originGuard } from "./middleware/auth";
import { errorBoundary } from "./middleware/error";
import type { GatewayConfig } from "./env";
import { openDatabase } from "./persistence/sqlite";
import { applyMigrations } from "./persistence/migrate";
import { ProfileStore } from "./domain/profileStore";
import { WorkspaceStore } from "./domain/workspaceStore";
import { AgentStore } from "./domain/agentStore";
import { profileRouter } from "./routes/profile";
import { workspacesRouter } from "./routes/workspaces";
import { agentsRouter } from "./routes/agents";

export function buildServer(cfg: GatewayConfig): Hono {
  const dbPath = join(cfg.profileDir, "data.sqlite");
  const db = openDatabase(dbPath);
  applyMigrations(db);

  const profileStore = new ProfileStore(db);
  const workspaceStore = new WorkspaceStore(db);
  const agentStore = new AgentStore(db, cfg.profileDir);

  const app = new Hono();
  app.use("*", errorBoundary);
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      apiVersion: "v1",
      gatewayVersion: "0.1.0",
      uptimeMs: Math.round(process.uptime() * 1000),
    }),
  );
  app.use("*", originGuard, authMiddleware(cfg.token));

  app.route("/", profileRouter(profileStore));
  app.route("/", workspacesRouter(workspaceStore));
  app.route("/", agentsRouter(agentStore));

  return app;
}
