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
        fs::create_dir_all(dir.join("workspaces"))?;

        let profile_path = dir.join("profile.json");
        if !profile_path.exists() {
            let profile_json = serde_json::to_string_pretty(profile)?;
            fs::write(profile_path, profile_json)?;
        }

        Ok(dir)
    }

    pub fn default_profile_id() -> ProfileId {
        ProfileId("default".to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn temp_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("vulture-core-test-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn ensure_profile_does_not_overwrite_existing_profile_json() {
        let root = temp_root();
        let layout = StorageLayout::new(AppPaths::new(&root));
        let profile = Profile::default_profile();
        let dir = root.join("profiles").join("default");
        let profile_json = dir.join("profile.json");

        fs::create_dir_all(&dir).expect("profile dir should be created");
        fs::write(&profile_json, "{\"existing\":true}").expect("profile json should be seeded");

        layout
            .ensure_profile(&profile)
            .expect("profile layout should be ensured");

        let contents = fs::read_to_string(&profile_json).expect("profile json should be readable");
        assert_eq!(contents, "{\"existing\":true}");
        assert!(dir.join("workspaces").is_dir());

        fs::remove_dir_all(root).expect("test root should be removable");
    }
}
