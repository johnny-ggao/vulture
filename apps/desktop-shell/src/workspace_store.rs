use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::Result;
use chrono::Utc;
use serde::Deserialize;
use vulture_core::WorkspaceDefinition;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceRequest {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone)]
pub struct WorkspaceStore {
    root: PathBuf,
}

impl WorkspaceStore {
    pub fn new(profile_dir: impl AsRef<Path>) -> Self {
        Self {
            root: profile_dir.as_ref().join("workspaces"),
        }
    }

    pub fn list(&self) -> Result<Vec<WorkspaceDefinition>> {
        fs::create_dir_all(&self.root)?;
        let mut workspaces = Vec::new();

        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
                workspaces.push(serde_json::from_str(&fs::read_to_string(entry.path())?)?);
            }
        }

        workspaces.sort_by(|left: &WorkspaceDefinition, right| left.name.cmp(&right.name));
        Ok(workspaces)
    }

    pub fn save(&self, request: SaveWorkspaceRequest) -> Result<WorkspaceDefinition> {
        fs::create_dir_all(&self.root)?;
        let now = Utc::now();
        let path = PathBuf::from(&request.path)
            .canonicalize()
            .map_err(|_| vulture_core::workspace::WorkspaceValidationError::MissingDirectory)?;
        let workspace = WorkspaceDefinition::new(
            request.id,
            request.name,
            path.to_string_lossy().to_string(),
            now,
        );

        workspace.validate()?;
        fs::write(
            self.root.join(format!("{}.json", workspace.id)),
            serde_json::to_string_pretty(&workspace)?,
        )?;
        Ok(workspace)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let path = self.root.join(format!("{id}.json"));
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn temp_profile_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "vulture-workspace-store-test-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn saves_and_lists_workspace() {
        let root = temp_profile_dir();
        let store = WorkspaceStore::new(&root);

        let saved = store
            .save(SaveWorkspaceRequest {
                id: "tmp".to_string(),
                name: "Temp".to_string(),
                path: std::env::temp_dir().to_string_lossy().to_string(),
            })
            .expect("workspace should save");
        let workspaces = store.list().expect("workspaces should list");

        assert_eq!(saved.id, "tmp");
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].id, "tmp");
        fs::remove_dir_all(root).expect("temp root should be removed");
    }

    #[test]
    fn rejects_missing_workspace_path() {
        let root = temp_profile_dir();
        let store = WorkspaceStore::new(&root);

        let error = store
            .save(SaveWorkspaceRequest {
                id: "missing".to_string(),
                name: "Missing".to_string(),
                path: "/path/that/does/not/exist".to_string(),
            })
            .expect_err("missing path should fail");

        assert_eq!(
            error.to_string(),
            "workspace path must be an existing directory"
        );
        fs::remove_dir_all(root).expect("temp root should be removed");
    }
}
