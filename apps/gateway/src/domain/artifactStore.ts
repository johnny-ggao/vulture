import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { readJsonFile, writeJsonFile } from "./jsonFileStore";

export type ArtifactKind = "file" | "text" | "link" | "data";

export interface ArtifactEntry {
  id: string;
  runId: string;
  conversationId: string;
  agentId: string;
  kind: ArtifactKind;
  title: string;
  mimeType: string | null;
  path: string | null;
  url: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  createdAt: Iso8601;
}

export interface CreateArtifactInput {
  runId: string;
  conversationId: string;
  agentId: string;
  kind: ArtifactKind;
  title: string;
  mimeType?: string | null;
  path?: string | null;
  url?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown>;
}

interface ArtifactFile {
  schemaVersion: 1;
  items: ArtifactEntry[];
}

const EMPTY_ARTIFACTS: ArtifactFile = { schemaVersion: 1, items: [] };

export class ArtifactStore {
  constructor(private readonly path: string) {}

  list(filter: { runId?: string; conversationId?: string; agentId?: string } = {}): ArtifactEntry[] {
    return this.read().items
      .filter((item) => !filter.runId || item.runId === filter.runId)
      .filter((item) => !filter.conversationId || item.conversationId === filter.conversationId)
      .filter((item) => !filter.agentId || item.agentId === filter.agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  create(input: CreateArtifactInput): ArtifactEntry {
    const entry = normalizeArtifact(input);
    const file = this.read();
    file.items.push(entry);
    this.write(file);
    return entry;
  }

  private read(): ArtifactFile {
    const parsed = readJsonFile<ArtifactFile>(this.path, EMPTY_ARTIFACTS);
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.items)) return EMPTY_ARTIFACTS;
    return { schemaVersion: 1, items: parsed.items.filter(isArtifact) };
  }

  private write(file: ArtifactFile): void {
    writeJsonFile(this.path, file);
  }
}

function normalizeArtifact(input: CreateArtifactInput): ArtifactEntry {
  const runId = input.runId.trim();
  if (!runId) throw new Error("runId is required");
  const conversationId = input.conversationId.trim();
  if (!conversationId) throw new Error("conversationId is required");
  const agentId = input.agentId.trim();
  if (!agentId) throw new Error("agentId is required");
  const title = input.title.trim();
  if (!title) throw new Error("title is required");
  if (!isKind(input.kind)) throw new Error("kind is invalid");
  return {
    id: `art-${crypto.randomUUID()}`,
    runId,
    conversationId,
    agentId,
    kind: input.kind,
    title,
    mimeType: input.mimeType?.trim() || null,
    path: input.path?.trim() || null,
    url: input.url?.trim() || null,
    content: input.content ?? null,
    metadata: sanitizeMetadata(input.metadata),
    createdAt: nowIso8601(),
  };
}

function sanitizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function isArtifact(value: unknown): value is ArtifactEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ArtifactEntry>;
  return (
    typeof item.id === "string" &&
    typeof item.runId === "string" &&
    typeof item.conversationId === "string" &&
    typeof item.agentId === "string" &&
    isKind(item.kind) &&
    typeof item.title === "string" &&
    (typeof item.mimeType === "string" || item.mimeType === null) &&
    (typeof item.path === "string" || item.path === null) &&
    (typeof item.url === "string" || item.url === null) &&
    (typeof item.content === "string" || item.content === null) &&
    typeof item.metadata === "object" &&
    item.metadata !== null &&
    !Array.isArray(item.metadata) &&
    typeof item.createdAt === "string"
  );
}

function isKind(value: unknown): value is ArtifactKind {
  return value === "file" || value === "text" || value === "link" || value === "data";
}
