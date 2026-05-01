import { join } from "node:path";
import type { GatewayConfig } from "../env";
import { openDatabase, type DB } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { importLegacy, type ImportResult } from "../migration/importLegacy";
import { ProfileStore } from "../domain/profileStore";
import { WorkspaceStore } from "../domain/workspaceStore";
import { AgentStore } from "../domain/agentStore";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { AttachmentStore } from "../domain/attachmentStore";
import { RunStore } from "../domain/runStore";
import { ConversationContextStore } from "../domain/conversationContextStore";
import {
  SubagentSessionStore,
  type SubagentSessionStatusChange,
} from "../domain/subagentSessionStore";
import { MemoryStore } from "../domain/memoryStore";
import { MemoryFileStore } from "../domain/memoryFileStore";
import { McpServerStore } from "../domain/mcpServerStore";
import { SkillCatalogStore } from "../domain/skillCatalogStore";
import { PermissionPolicyStore } from "../domain/permissionPolicyStore";
import { ArtifactStore } from "../domain/artifactStore";
import { WebSearchSettingsStore } from "../domain/webSearchSettingsStore";
import { makeOpenAIEmbeddingProvider } from "../runtime/openaiEmbeddings";

export interface GatewayStores {
  db: DB;
  profileStore: ProfileStore;
  workspaceStore: WorkspaceStore;
  agentStore: AgentStore;
  conversationStore: ConversationStore;
  messageStore: MessageStore;
  attachmentStore: AttachmentStore;
  runStore: RunStore;
  conversationContextStore: ConversationContextStore;
  subagentSessionStore: SubagentSessionStore;
  memoryStore: MemoryStore;
  mcpServerStore: McpServerStore;
  skillCatalogStore: SkillCatalogStore;
  permissionPolicyStore: PermissionPolicyStore;
  artifactStore: ArtifactStore;
  webSearchSettingsStore: WebSearchSettingsStore;
  embedMemoryText: ReturnType<typeof makeOpenAIEmbeddingProvider>;
  memoryFileStore: MemoryFileStore;
}

export interface CreateGatewayStoresOptions {
  cfg: GatewayConfig;
  onSubagentStatusChange?: (change: SubagentSessionStatusChange) => void;
}

export function createGatewayStores(
  opts: CreateGatewayStoresOptions,
): { stores: GatewayStores; importResult: ImportResult } {
  const { cfg } = opts;
  const dbPath = join(cfg.profileDir, "data.sqlite");
  const db = openDatabase(dbPath);
  applyMigrations(db);

  const importResult = importLegacy({
    profileDir: cfg.profileDir,
    db,
    privateWorkspaceHomeDir: cfg.privateWorkspaceHomeDir,
  });

  const profileStore = new ProfileStore(db, cfg.profileDir);
  const workspaceStore = new WorkspaceStore(db);
  const agentStore = new AgentStore(
    db,
    cfg.profileDir,
    cfg.defaultWorkspace,
    cfg.privateWorkspaceHomeDir,
  );
  const conversationStore = new ConversationStore(db);
  const messageStore = new MessageStore(db);
  const attachmentStore = new AttachmentStore(db, cfg.profileDir);
  const runStore = new RunStore(db);
  const conversationContextStore = new ConversationContextStore(db);
  const subagentSessionStore = new SubagentSessionStore(db, {
    runs: runStore,
    messages: messageStore,
    onStatusChange: opts.onSubagentStatusChange,
  });
  const memoryStore = new MemoryStore(db);
  const mcpServerStore = new McpServerStore(db);
  const skillCatalogStore = new SkillCatalogStore(cfg.profileDir);
  const permissionPolicyStore = new PermissionPolicyStore(
    join(cfg.profileDir, "policies", "permission-policies.json"),
  );
  const artifactStore = new ArtifactStore(join(cfg.profileDir, "artifacts", "index.json"));
  const webSearchSettingsStore = new WebSearchSettingsStore(
    join(cfg.profileDir, "settings", "web-search.json"),
  );
  const embedMemoryText = makeOpenAIEmbeddingProvider();
  const memoryFileStore = new MemoryFileStore({
    db,
    legacy: memoryStore,
    embed: embedMemoryText,
  });

  return {
    importResult,
    stores: {
      db,
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
    },
  };
}
