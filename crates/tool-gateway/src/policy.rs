use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
};

use crate::{PolicyDecision, ToolRequest};

#[derive(Debug, Default)]
pub struct PolicyEngine {
    workspace_root: Option<PathBuf>,
}

impl PolicyEngine {
    pub fn for_workspace(root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: Some(root.into()),
        }
    }

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
            tool if is_browser_tool(tool) => PolicyDecision::Ask {
                reason: format!("{tool} requires browser approval"),
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

        let Some(workspace_root) = self.workspace_root.as_deref() else {
            return PolicyDecision::Ask {
                reason: "file.read outside known workspace".to_string(),
            };
        };

        let Some(workspace_root) = normalize_root(workspace_root) else {
            return PolicyDecision::Ask {
                reason: "file.read outside known workspace".to_string(),
            };
        };

        if is_inside_root(Path::new(path), &workspace_root) {
            PolicyDecision::Allow
        } else {
            PolicyDecision::Ask {
                reason: "file.read outside workspace".to_string(),
            }
        }
    }
}

fn normalize_root(root: &Path) -> Option<Vec<OsString>> {
    let components = normalize_absolute(root)?;
    (!components.is_empty()).then_some(components)
}

fn is_inside_root(path: &Path, root: &[OsString]) -> bool {
    let Some(path_components) = normalize_absolute_inside_root(path, root) else {
        return false;
    };

    path_components.starts_with(root)
}

fn is_browser_tool(tool: &str) -> bool {
    matches!(
        tool,
        "browser.open"
            | "browser.attach"
            | "browser.snapshot"
            | "browser.click"
            | "browser.input"
            | "browser.scroll"
            | "browser.keypress"
            | "browser.extract"
            | "browser.close_agent_tabs"
            | "browser.forward_cdp_limited"
    )
}

fn normalize_absolute(path: &Path) -> Option<Vec<OsString>> {
    normalize_absolute_inside_root(path, &[])
}

fn normalize_absolute_inside_root(path: &Path, root: &[OsString]) -> Option<Vec<OsString>> {
    if !path.is_absolute() {
        return None;
    }

    let mut components = Vec::new();

    for component in path.components() {
        match component {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {}
            Component::Normal(value) => components.push(value.to_os_string()),
            Component::ParentDir => {
                if components.is_empty() || (!root.is_empty() && components == root) {
                    return None;
                }

                components.pop();
            }
        }
    }

    Some(components)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn allows_file_read_inside_workspace() {
        let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
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
    fn asks_for_file_read_traversal_outside_workspace() {
        let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
        let request = ToolRequest {
            run_id: "run_1".to_string(),
            tool: "file.read".to_string(),
            input: json!({
                "path": "/tmp/vulture-workspace/../secret.txt",
                "workspaceRoot": "/tmp/vulture-workspace"
            }),
        };

        assert_eq!(
            engine.decide(&request),
            PolicyDecision::Ask {
                reason: "file.read outside workspace".to_string()
            }
        );
    }

    #[test]
    fn asks_for_file_read_with_empty_trusted_root() {
        let engine = PolicyEngine::for_workspace("");
        let request = ToolRequest {
            run_id: "run_1".to_string(),
            tool: "file.read".to_string(),
            input: json!({ "path": "/tmp/vulture-workspace/README.md" }),
        };

        assert_eq!(
            engine.decide(&request),
            PolicyDecision::Ask {
                reason: "file.read outside known workspace".to_string()
            }
        );
    }

    #[test]
    fn asks_for_relative_file_read_path() {
        let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
        let request = ToolRequest {
            run_id: "run_1".to_string(),
            tool: "file.read".to_string(),
            input: json!({ "path": "README.md" }),
        };

        assert_eq!(
            engine.decide(&request),
            PolicyDecision::Ask {
                reason: "file.read outside workspace".to_string()
            }
        );
    }

    #[test]
    fn asks_for_shell_exec() {
        let engine = PolicyEngine::default();
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

    #[test]
    fn asks_for_browser_attach_and_actions() {
        let engine = PolicyEngine::default();
        let tools = [
            "browser.open",
            "browser.attach",
            "browser.snapshot",
            "browser.click",
            "browser.input",
            "browser.scroll",
            "browser.keypress",
            "browser.extract",
            "browser.close_agent_tabs",
            "browser.forward_cdp_limited",
        ];

        for tool in tools {
            let request = ToolRequest {
                run_id: "run_1".to_string(),
                tool: tool.to_string(),
                input: json!({}),
            };

            assert_eq!(
                engine.decide(&request),
                PolicyDecision::Ask {
                    reason: format!("{tool} requires browser approval")
                }
            );
        }
    }

    #[test]
    fn denies_raw_browser_control_alias() {
        let engine = PolicyEngine::default();
        let request = ToolRequest {
            run_id: "run_1".to_string(),
            tool: "browser.control".to_string(),
            input: json!({}),
        };

        assert_eq!(
            engine.decide(&request),
            PolicyDecision::Deny {
                reason: "unknown tool browser.control".to_string()
            }
        );
    }
}
