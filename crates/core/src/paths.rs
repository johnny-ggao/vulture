use std::path::{Component, Path, PathBuf};

use crate::{CoreResult, ProfileId};

#[derive(Debug, Clone)]
pub struct AppPaths {
    root: PathBuf,
}

impl AppPaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn profiles_dir(&self) -> PathBuf {
        self.root.join("profiles")
    }

    pub fn profile_dir(&self, profile_id: &ProfileId) -> CoreResult<PathBuf> {
        if profile_id.0.is_empty() || profile_id.0.contains(['/', '\\']) {
            return Err(crate::CoreError::InvalidProfileId(profile_id.0.clone()));
        }

        let mut components = Path::new(&profile_id.0).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(_)), None) => Ok(self.profiles_dir().join(&profile_id.0)),
            _ => Err(crate::CoreError::InvalidProfileId(profile_id.0.clone())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_profile_ids() {
        let paths = AppPaths::new("/tmp/vulture");

        for invalid_id in ["", ".", "..", "../escape", "foo/bar", "foo\\bar"] {
            let err = paths
                .profile_dir(&ProfileId(invalid_id.to_string()))
                .expect_err("invalid profile id should be rejected");

            assert!(matches!(err, crate::CoreError::InvalidProfileId(id) if id == invalid_id));
        }
    }
}
