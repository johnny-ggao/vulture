use std::path::{Path, PathBuf};

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
        if profile_id.0.contains('/') || profile_id.0.contains("..") {
            return Err(crate::CoreError::InvalidProfileId(profile_id.0.clone()));
        }

        Ok(self.profiles_dir().join(&profile_id.0))
    }
}
