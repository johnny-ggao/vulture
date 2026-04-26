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
        let is_valid = !profile_id.0.is_empty()
            && profile_id.0 != "."
            && profile_id.0 != ".."
            && profile_id
                .0
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));

        if !is_valid {
            return Err(crate::CoreError::InvalidProfileId(profile_id.0.clone()));
        }

        Ok(self.profiles_dir().join(&profile_id.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_profile_ids() {
        let paths = AppPaths::new("/tmp/vulture");

        for invalid_id in [
            "",
            ".",
            "..",
            "../escape",
            "foo/bar",
            "foo\\bar",
            "/rooted",
            "C:",
            "C:foo",
        ] {
            let err = paths
                .profile_dir(&ProfileId(invalid_id.to_string()))
                .expect_err("invalid profile id should be rejected");

            assert!(matches!(err, crate::CoreError::InvalidProfileId(id) if id == invalid_id));
        }
    }

    #[test]
    fn resolves_valid_profile_id() {
        let paths = AppPaths::new("/tmp/vulture");

        let dir = paths
            .profile_dir(&ProfileId("team.profile-1_default".to_string()))
            .expect("valid profile id should resolve");

        assert_eq!(
            dir,
            PathBuf::from("/tmp/vulture/profiles/team.profile-1_default")
        );
    }
}
