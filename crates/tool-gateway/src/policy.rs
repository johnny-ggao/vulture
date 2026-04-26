use std::path::Path;

use crate::{PolicyDecision, ToolRequest};

#[derive(Debug, Default)]
pub struct PolicyEngine;

impl PolicyEngine {
    pub fn decide(&self, request: &ToolRequest) -> PolicyDecision {
        match request.tool.as_str() {
            "file.read" => self.decide_file_read(request),
            "file.write" => PolicyDecision::Ask {
                reason: "file.write requires approval".to_string(),
            },
            "shell.exec" => PolicyDecision::Ask {
                reason: "shell.exec requires approval".to_string(),
            },
            tool if tool.starts_with("git.") => PolicyDecision::Ask {
                reason: format!("{tool} requires approval"),
            },
            other => PolicyDecision::Deny {
                reason: format!("unknown tool {other}"),
            },
        }
    }

    fn decide_file_read(&self, request: &ToolRequest) -> PolicyDecision {
        let Some(path) = request.input.get("path").and_then(|value| value.as_str()) else {
            return PolicyDecision::Deny {
                reason: "file.read missing path".to_string(),
            };
        };

        let Some(workspace_root) = request
            .input
            .get("workspaceRoot")
            .and_then(|value| value.as_str())
        else {
            return PolicyDecision::Ask {
                reason: "file.read outside known workspace".to_string(),
            };
        };

        if Path::new(path).starts_with(Path::new(workspace_root)) {
            PolicyDecision::Allow
        } else {
            PolicyDecision::Ask {
                reason: "file.read outside workspace".to_string(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn allows_file_read_inside_workspace() {
        let engine = PolicyEngine;
        let request = ToolRequest {
            run_id: "run_1".to_string(),
            tool: "file.read".to_string(),
            input: json!({
                "path": "/tmp/vulture-workspace/README.md",
                "workspaceRoot": "/tmp/vulture-workspace"
            }),
        };

        assert_eq!(engine.decide(&request), PolicyDecision::Allow);
    }

    #[test]
    fn asks_for_shell_exec() {
        let engine = PolicyEngine;
        let request = ToolRequest {
            run_id: "run_1".to_string(),
            tool: "shell.exec".to_string(),
            input: json!({ "argv": ["bun", "test"], "cwd": "/tmp/vulture-workspace" }),
        };

        assert_eq!(
            engine.decide(&request),
            PolicyDecision::Ask {
                reason: "shell.exec requires approval".to_string()
            }
        );
    }
}
