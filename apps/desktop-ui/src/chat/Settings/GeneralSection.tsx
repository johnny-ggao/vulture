import { useState } from "react";
import type { SettingsPageProps } from "./types";

export function GeneralSection(props: SettingsPageProps) {
  const [profileName, setProfileName] = useState("");
  const [busy, setBusy] = useState(false);

  async function createProfile() {
    const name = profileName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await props.onCreateProfile(name);
      setProfileName("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-card">
        <h3>Profiles</h3>
        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          {props.profiles.map((profile) => {
            const active = profile.id === props.activeProfileId;
            const switching = props.switchingProfileId === profile.id;
            return (
              <div
                key={profile.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "9px 0",
                  borderBottom: "1px solid var(--fill-quaternary)",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{profile.name}</div>
                  <div style={{ color: "var(--text-tertiary)", fontSize: 12 }}>{profile.id}</div>
                </div>
                <button
                  type="button"
                  className={active ? "btn-primary" : "btn-secondary"}
                  disabled={active || props.switchingProfileId !== null}
                  onClick={() => props.onSwitchProfile(profile.id)}
                >
                  {active ? "当前" : switching ? "切换中..." : "切换"}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={profileName}
            placeholder="Profile name"
            onChange={(event) => setProfileName(event.target.value)}
            style={{
              flex: 1,
              padding: "8px 10px",
              border: "1px solid var(--fill-tertiary)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-primary)",
              fontSize: 14,
            }}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={busy || props.switchingProfileId !== null || !profileName.trim()}
            onClick={createProfile}
          >
            {busy ? "..." : "新建并切换"}
          </button>
        </div>
      </div>

      <div className="page-card">
        <h3>通用</h3>
        <p style={{ marginBottom: 12 }}>主题：跟随系统（已支持暗色模式）</p>
        <p style={{ color: "var(--text-tertiary)", fontSize: 12 }}>当前 UI 版本：Phase 3d 设计刷新</p>
      </div>
    </>
  );
}
