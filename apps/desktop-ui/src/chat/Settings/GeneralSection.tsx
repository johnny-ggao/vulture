import { useState } from "react";
import { Field, SectionCard } from "../components";
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
      <SectionCard title="Profiles" description="切换或新建 profile（独立的 agent 集合 + 设置）">
        <div className="profile-list">
          {props.profiles.map((profile) => {
            const active = profile.id === props.activeProfileId;
            const switching = props.switchingProfileId === profile.id;
            return (
              <div key={profile.id} className="profile-row">
                <div>
                  <div className="profile-name">{profile.name}</div>
                  <div className="profile-id">{profile.id}</div>
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
        <div className="profile-create">
          <Field label="新建 profile">
            <input
              value={profileName}
              placeholder="Profile name"
              onChange={(event) => setProfileName(event.target.value)}
            />
          </Field>
          <button
            type="button"
            className="btn-primary profile-create-submit"
            disabled={busy || props.switchingProfileId !== null || !profileName.trim()}
            onClick={createProfile}
          >
            {busy ? "..." : "新建并切换"}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="通用">
        <p className="general-row">主题：跟随系统（已支持暗色模式）</p>
        <p className="general-row general-meta">当前 UI 版本：Phase 3d 设计刷新</p>
      </SectionCard>
    </>
  );
}
