import type { Hono } from "hono";
import type { GatewayConfig } from "../env";
import type { GatewayStores } from "./stores";
import { profileRouter } from "../routes/profile";
import { workspacesRouter } from "../routes/workspaces";
import { agentsRouter } from "../routes/agents";
import { skillsRouter } from "../routes/skills";
import { toolsRouter } from "../routes/tools";
import { memoriesRouter } from "../routes/memories";
import { conversationsRouter } from "../routes/conversations";
import { subagentSessionsRouter } from "../routes/subagentSessions";
import { runsRouter, type RunsDeps } from "../routes/runs";
import { attachmentsRouter } from "../routes/attachments";
import { mcpServersRouter } from "../routes/mcpServers";
import { skillCatalogRouter } from "../routes/skillCatalog";
import { permissionPoliciesRouter } from "../routes/permissionPolicies";
import { artifactsRouter } from "../routes/artifacts";
import { runLogsRouter } from "../routes/runLogs";
import { runTraceRouter } from "../routes/runTrace";
import { browserCapabilitiesRouter } from "../routes/browserCapabilities";
import { mcpProxyRouter } from "../routes/mcpProxy";
import { runtimeDiagnosticsRouter } from "../routes/runtimeDiagnostics";
import { modelSettingsRouter } from "../routes/modelSettings";
import { filesRouter } from "../routes/files";
import {
  makeWebSearchSettingsTester,
  webSearchSettingsRouter,
} from "../routes/webSearchSettings";
import type { McpClientManager } from "../runtime/mcpClientManager";

type StoreRunDeps =
  | "conversations"
  | "messages"
  | "attachments"
  | "runs"
  | "contexts";

export type GatewayRunRuntimeDeps = Omit<RunsDeps, StoreRunDeps>;

export interface MountGatewayRoutesOptions {
  app: Hono;
  cfg: GatewayConfig;
  stores: GatewayStores;
  runRuntime: GatewayRunRuntimeDeps;
  mcpClientManager: McpClientManager;
}

export function mountGatewayRoutes(opts: MountGatewayRoutesOptions): void {
  const { app, cfg, stores, runRuntime, mcpClientManager } = opts;
  const {
    profileStore,
    workspaceStore,
    agentStore,
    conversationStore,
    messageStore,
    attachmentStore,
    runStore,
    conversationContextStore,
    subagentSessionStore,
    memoryStore,
    mcpServerStore,
    skillCatalogStore,
    permissionPolicyStore,
    artifactStore,
    webSearchSettingsStore,
    embedMemoryText,
    memoryFileStore,
  } = stores;

  app.route("/", profileRouter(profileStore));
  app.route("/", workspacesRouter(workspaceStore));
  app.route("/", agentsRouter(agentStore));
  app.route("/", toolsRouter());
  app.route(
    "/",
    webSearchSettingsRouter({
      store: webSearchSettingsStore,
      testSearch: makeWebSearchSettingsTester(),
    }),
  );
  app.route("/", skillsRouter(cfg.profileDir));
  app.route("/", skillCatalogRouter(skillCatalogStore));
  app.route("/", permissionPoliciesRouter(permissionPolicyStore));
  app.route("/", artifactsRouter(artifactStore));
  app.route(
    "/",
    runLogsRouter({
      runs: runStore,
      subagentSessions: subagentSessionStore,
      artifacts: artifactStore,
    }),
  );
  app.route("/", browserCapabilitiesRouter());
  app.route("/", mcpProxyRouter());
  app.route("/", runtimeDiagnosticsRouter());
  app.route(
    "/",
    modelSettingsRouter({
      shellCallbackUrl: cfg.shellCallbackUrl,
      shellToken: cfg.token,
      env: process.env,
    }),
  );
  app.route("/", filesRouter());
  app.route(
    "/",
    mcpServersRouter({
      store: mcpServerStore,
      runtime: {
        status: (serverId) => mcpClientManager.status(serverId),
        reconnect: (serverId) => mcpClientManager.reconnect(serverId),
        tools: (serverId) => mcpClientManager.listTools(serverId),
      },
    }),
  );
  app.route(
    "/",
    memoriesRouter({
      agents: agentStore,
      memories: memoryStore,
      memoryFiles: memoryFileStore,
      embed: embedMemoryText,
    }),
  );
  app.route("/", attachmentsRouter(attachmentStore));
  app.route(
    "/",
    conversationsRouter({
      conversations: conversationStore,
      messages: messageStore,
      contexts: conversationContextStore,
    }),
  );
  app.route(
    "/",
    subagentSessionsRouter({
      sessions: subagentSessionStore,
      messages: messageStore,
      runs: runStore,
    }),
  );
  app.route(
    "/",
    runsRouter({
      conversations: conversationStore,
      messages: messageStore,
      attachments: attachmentStore,
      runs: runStore,
      contexts: conversationContextStore,
      ...runRuntime,
    }),
  );
  app.route(
    "/",
    runTraceRouter({
      runs: runStore,
      messages: messageStore,
      subagentSessions: subagentSessionStore,
      artifacts: artifactStore,
    }),
  );
}
