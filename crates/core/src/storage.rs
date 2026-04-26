use std::fs;
use std::path::PathBuf;

use crate::{AppPaths, CoreResult, Profile, ProfileId};

#[derive(Debug, Clone)]
pub struct StorageLayout {
    paths: AppPaths,
}

impl StorageLayout {
    pub fn new(paths: AppPaths) -> Self {
        Self { paths }
    }

    pub fn ensure_profile(&self, profile: &Profile) -> CoreResult<PathBuf> {
        let dir = self.paths.profile_dir(&profile.id)?;
        fs::create_dir_all(dir.join("agents"))?;
        fs::create_dir_all(dir.join("conversations"))?;
        fs::create_dir_all(dir.join("permissions"))?;

        let profile_json = serde_json::to_string_pretty(profile)?;
        fs::write(dir.join("profile.json"), profile_json)?;

        Ok(dir)
    }

    pub fn default_profile_id() -> ProfileId {
        ProfileId("default".to_string())
    }
}
