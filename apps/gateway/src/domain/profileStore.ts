import type { DB } from "../persistence/sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Profile,
  ProfileId,
  AgentId,
  UpdateProfileRequest,
} from "@vulture/protocol/src/v1/profile";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";

const DEFAULT_ID = "default" as ProfileId;
const DEFAULT_NAME = "Default";
const DEFAULT_ACTIVE_AGENT = "local-work-agent" as AgentId;

interface ProfileSeed {
  id: ProfileId;
  name: string;
  activeAgentId: AgentId | null;
}

interface ProfileJson {
  id?: unknown;
  name?: unknown;
  active_agent_id?: unknown;
}

interface ProfileRow {
  id: string;
  name: string;
  active_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProfile(r: ProfileRow): Profile {
  return {
    id: r.id as ProfileId,
    name: r.name,
    activeAgentId: (r.active_agent_id ?? null) as AgentId | null,
    createdAt: r.created_at as Iso8601,
    updatedAt: r.updated_at as Iso8601,
  };
}

export class ProfileStore {
  private readonly seed: ProfileSeed;

  constructor(
    private readonly db: DB,
    profileDir?: string,
  ) {
    this.seed = readProfileSeed(profileDir);
  }

  get(): Profile {
    this.ensureSeed();
    const row = this.db
      .query(
        "SELECT id, name, active_agent_id, created_at, updated_at FROM profile WHERE id = ?"
      )
      .get(this.seed.id) as ProfileRow;
    return rowToProfile(row);
  }

  update(req: UpdateProfileRequest): Profile {
    this.ensureSeed();
    const now = nowIso8601();
    if (req.name !== undefined) {
      this.db
        .query("UPDATE profile SET name = ?, updated_at = ? WHERE id = ?")
        .run(req.name, now, this.seed.id);
    }
    if (req.activeAgentId !== undefined) {
      this.db
        .query(
          "UPDATE profile SET active_agent_id = ?, updated_at = ? WHERE id = ?"
        )
        .run(req.activeAgentId, now, this.seed.id);
    }
    return this.get();
  }

  private ensureSeed(): void {
    const existing = this.db
      .query("SELECT 1 FROM profile WHERE id = ?")
      .get(this.seed.id);
    if (existing) return;
    const now = nowIso8601();
    this.db
      .query(
        "INSERT INTO profile(id, name, active_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(this.seed.id, this.seed.name, this.seed.activeAgentId, now, now);
  }
}

function readProfileSeed(profileDir?: string): ProfileSeed {
  const fallback = {
    id: DEFAULT_ID,
    name: DEFAULT_NAME,
    activeAgentId: DEFAULT_ACTIVE_AGENT,
  };
  if (!profileDir) return fallback;
  const profilePath = join(profileDir, "profile.json");
  if (!existsSync(profilePath)) return fallback;

  try {
    const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as ProfileJson;
    const id = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : fallback.id;
    const name =
      typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : fallback.name;
    const activeAgentId =
      typeof parsed.active_agent_id === "string" && parsed.active_agent_id.trim()
        ? (parsed.active_agent_id as AgentId)
        : fallback.activeAgentId;
    return {
      id: id as ProfileId,
      name,
      activeAgentId,
    };
  } catch {
    return fallback;
  }
}
