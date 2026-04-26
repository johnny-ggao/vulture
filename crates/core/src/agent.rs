use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::WorkspaceDefinition;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model: String,
    pub reasoning: String,
    pub tools: Vec<String>,
    #[serde(default)]
    pub workspace: Option<WorkspaceDefinition>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRecord {
    pub definition: AgentDefinition,
    pub instructions: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AgentValidationError {
    #[error("agent id must be a lowercase slug")]
    InvalidId,
    #[error("agent name must not be empty")]
    EmptyName,
    #[error("agent model must not be empty")]
    EmptyModel,
    #[error("agent instructions must not be empty")]
    EmptyInstructions,
    #[error("unsupported agent tool {0}")]
    UnsupportedTool(String),
    #[error("agent workspace must be an existing directory")]
    InvalidWorkspace,
}

pub const SUPPORTED_AGENT_TOOLS: &[&str] = &["shell.exec", "browser.snapshot", "browser.click"];

impl AgentRecord {
    pub fn default_local_work_agent(now: DateTime<Utc>) -> Self {
        Self {
            definition: AgentDefinition {
                id: "local-work-agent".to_string(),
                name: "Local Work Agent".to_string(),
                description: "General local work assistant".to_string(),
                model: "gpt-5.4".to_string(),
                reasoning: "medium".to_string(),
                tools: SUPPORTED_AGENT_TOOLS
                    .iter()
                    .map(|tool| (*tool).to_string())
                    .collect(),
                workspace: None,
                created_at: now,
                updated_at: now,
            },
            instructions: [
                "You are Vulture's local work agent.",
                "Complete the user's task directly; do not reply with standby text like asking for another task.",
                "For workspace questions, inspect the repository structure before summarizing.",
                "Request local actions through tools and never claim a local command ran unless a tool result confirms it.",
                "Answer in concise Chinese when the user writes Chinese.",
            ]
            .join(" "),
        }
    }

    pub fn validate(&self) -> Result<(), AgentValidationError> {
        if !is_slug(&self.definition.id) {
            return Err(AgentValidationError::InvalidId);
        }
        if self.definition.name.trim().is_empty() {
            return Err(AgentValidationError::EmptyName);
        }
        if self.definition.model.trim().is_empty() {
            return Err(AgentValidationError::EmptyModel);
        }
        if self.instructions.trim().is_empty() {
            return Err(AgentValidationError::EmptyInstructions);
        }
        for tool in &self.definition.tools {
            if !SUPPORTED_AGENT_TOOLS.contains(&tool.as_str()) {
                return Err(AgentValidationError::UnsupportedTool(tool.clone()));
            }
        }
        if let Some(workspace) = &self.definition.workspace {
            workspace
                .validate()
                .map_err(|_| AgentValidationError::InvalidWorkspace)?;
        }
        Ok(())
    }
}

pub fn is_slug(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_agent_is_valid() {
        let agent = AgentRecord::default_local_work_agent(Utc::now());
        agent.validate().expect("default agent should be valid");
        assert_eq!(agent.definition.id, "local-work-agent");
        assert!(agent.definition.tools.contains(&"shell.exec".to_string()));
    }

    #[test]
    fn rejects_unsupported_tools() {
        let mut agent = AgentRecord::default_local_work_agent(Utc::now());
        agent.definition.tools = vec!["file.write".to_string()];
        assert_eq!(
            agent.validate(),
            Err(AgentValidationError::UnsupportedTool(
                "file.write".to_string()
            ))
        );
    }

    #[test]
    fn validates_slug_ids() {
        assert!(is_slug("browser-researcher"));
        assert!(!is_slug("Browser Researcher"));
        assert!(!is_slug("-browser"));
        assert!(!is_slug("browser-"));
    }
}
