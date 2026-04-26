import type { DB } from "../persistence/sqlite";
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
  constructor(private readonly db: DB) {}

  get(): Profile {
    this.ensureDefault();
    const row = this.db
      .query(
        "SELECT id, name, active_agent_id, created_at, updated_at FROM profile WHERE id = ?"
      )
      .get(DEFAULT_ID) as ProfileRow;
    return rowToProfile(row);
  }

  update(req: UpdateProfileRequest): Profile {
    this.ensureDefault();
    const now = nowIso8601();
    if (req.name !== undefined) {
      this.db
        .query("UPDATE profile SET name = ?, updated_at = ? WHERE id = ?")
        .run(req.name, now, DEFAULT_ID);
    }
    if (req.activeAgentId !== undefined) {
      this.db
        .query(
          "UPDATE profile SET active_agent_id = ?, updated_at = ? WHERE id = ?"
        )
        .run(req.activeAgentId, now, DEFAULT_ID);
    }
    return this.get();
  }

  private ensureDefault(): void {
    const existing = this.db
      .query("SELECT 1 FROM profile WHERE id = ?")
      .get(DEFAULT_ID);
    if (existing) return;
    const now = nowIso8601();
    this.db
      .query(
        "INSERT INTO profile(id, name, active_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(DEFAULT_ID, DEFAULT_NAME, DEFAULT_ACTIVE_AGENT, now, now);
  }
}
