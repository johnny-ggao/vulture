use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::agent::is_slug;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDefinition {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkspaceValidationError {
    #[error("workspace id must be a lowercase slug")]
    InvalidId,
    #[error("workspace name must not be empty")]
    EmptyName,
    #[error("workspace path must be an existing directory")]
    MissingDirectory,
}

impl WorkspaceDefinition {
    pub fn new(id: String, name: String, path: String, now: DateTime<Utc>) -> Self {
        Self {
            id,
            name,
            path,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn validate(&self) -> Result<(), WorkspaceValidationError> {
        if !is_slug(&self.id) {
            return Err(WorkspaceValidationError::InvalidId);
        }
        if self.name.trim().is_empty() {
            return Err(WorkspaceValidationError::EmptyName);
        }
        if !Path::new(&self.path).is_dir() {
            return Err(WorkspaceValidationError::MissingDirectory);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_existing_workspace_path() {
        let workspace = WorkspaceDefinition::new(
            "tmp".to_string(),
            "Temp".to_string(),
            std::env::temp_dir().to_string_lossy().to_string(),
            Utc::now(),
        );
        workspace.validate().expect("temp dir should be valid");
    }

    #[test]
    fn rejects_missing_workspace_path() {
        let workspace = WorkspaceDefinition::new(
            "missing".to_string(),
            "Missing".to_string(),
            "/path/that/does/not/exist".to_string(),
            Utc::now(),
        );
        assert_eq!(
            workspace.validate(),
            Err(WorkspaceValidationError::MissingDirectory)
        );
    }
}
