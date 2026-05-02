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
            "shell.exec" => self.decide_shell_exec(request),
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

    fn decide_shell_exec(&self, request: &ToolRequest) -> PolicyDecision {
        let Some(cwd) = request.input.get("cwd").and_then(|value| value.as_str()) else {
            return PolicyDecision::Ask {
                reason: "shell.exec missing cwd".to_string(),
            };
        };

        let Some(workspace_root) = self.workspace_root.as_deref() else {
            return PolicyDecision::Ask {
                reason: "shell.exec outside known workspace".to_string(),
            };
        };

        let Some(workspace_root) = normalize_root(workspace_root) else {
            return PolicyDecision::Ask {
                reason: "shell.exec outside known workspace".to_string(),
            };
        };

        let cwd = Path::new(cwd);
        if !is_inside_root(cwd, &workspace_root) {
            return PolicyDecision::Ask {
                reason: "shell.exec outside workspace".to_string(),
            };
        }

        if shell_exec_references_outside_workspace(request, cwd, &workspace_root) {
            return PolicyDecision::Ask {
                reason: "shell.exec references path outside workspace".to_string(),
            };
        }

        PolicyDecision::Allow
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
            | "browser.navigate"
            | "browser.wait"
            | "browser.screenshot"
            | "browser.close_agent_tabs"
            | "browser.forward_cdp_limited"
    )
}

fn shell_exec_references_outside_workspace(
    request: &ToolRequest,
    cwd: &Path,
    root: &[OsString],
) -> bool {
    let Some(argv) = request.input.get("argv").and_then(|value| value.as_array()) else {
        return false;
    };

    let args = argv
        .iter()
        .filter_map(|value| value.as_str())
        .collect::<Vec<_>>();

    args.iter()
        .skip(1)
        .any(|arg| shell_arg_references_outside_workspace(arg, cwd, root))
        || shell_command_references_outside_workspace(&args, cwd, root)
}

fn shell_arg_references_outside_workspace(arg: &str, cwd: &Path, root: &[OsString]) -> bool {
    if arg.is_empty() || arg.starts_with('-') || arg.contains("://") {
        return false;
    }

    let path = Path::new(arg);
    if path.is_absolute() {
        return !is_inside_root(path, root);
    }

    if looks_like_relative_path(arg) {
        return !is_inside_root(&cwd.join(path), root);
    }

    false
}

fn shell_command_references_outside_workspace(
    args: &[&str],
    cwd: &Path,
    root: &[OsString],
) -> bool {
    let Some(shell) = args.first().and_then(|arg| Path::new(arg).file_name()) else {
        return false;
    };
    let shell = shell.to_string_lossy();
    if !matches!(shell.as_ref(), "bash" | "sh" | "zsh") {
        return false;
    }

    let Some(command) = shell_command_arg(args) else {
        return false;
    };

    command
        .split(|c: char| {
            c.is_whitespace() || matches!(c, '"' | '\'' | ';' | '&' | '|' | '<' | '>' | '(' | ')')
        })
        .filter(|token| !token.is_empty())
        .any(|token| shell_arg_references_outside_workspace(token, cwd, root))
}

fn shell_command_arg<'a>(args: &'a [&str]) -> Option<&'a str> {
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        if *arg == "-c" || *arg == "-lc" {
            return iter.next().copied();
        }
        if arg.starts_with('-') && arg.contains('c') {
            return iter.next().copied();
        }
    }
    None
}

fn looks_like_relative_path(arg: &str) -> bool {
    arg == "."
        || arg == ".."
        || arg.starts_with("./")
        || arg.starts_with("../")
        || arg.contains('/')
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

        assert!(matches!(
            engine.decide(&request),
            PolicyDecision::Ask { .. }
        ));
    }

    #[test]
    fn allows_shell_exec_inside_workspace() {
        let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
        let request = ToolRequest {
            run_id: "r1".into(),
            tool: "shell.exec".into(),
            input: serde_json::json!({
                "cwd": "/tmp/vulture-workspace/src",
                "argv": ["echo", "hi"]
            }),
        };
        assert_eq!(engine.decide(&request), PolicyDecision::Allow);
    }

    #[test]
    fn asks_shell_exec_when_argv_references_absolute_path_outside_workspace() {
        let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
        let request = ToolRequest {
            run_id: "r1".into(),
            tool: "shell.exec".into(),
            input: serde_json::json!({
                "cwd": "/tmp/vulture-workspace",
                "argv": ["cat", "/etc/hosts"]
            }),
        };
        assert_eq!(
            engine.decide(&request),
            PolicyDecision::Ask {
                reason: "shell.exec references path outside workspace".to_string()
            }
        );
    }

    #[test]
    fn asks_shell_exec_when_shell_command_references_absolute_path_outside_workspace() {
        let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
        let request = ToolRequest {
            run_id: "r1".into(),
            tool: "shell.exec".into(),
            input: serde_json::json!({
                "cwd": "/tmp/vulture-workspace",
                "argv": ["bash", "-lc", "cat /etc/hosts"]
            }),
        };
        assert_eq!(
            engine.decide(&request),
            PolicyDecision::Ask {
                reason: "shell.exec references path outside workspace".to_string()
            }
        );
    }

    #[test]
    fn asks_shell_exec_outside_workspace() {
        let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
        let request = ToolRequest {
            run_id: "r1".into(),
            tool: "shell.exec".into(),
            input: serde_json::json!({
                "cwd": "/etc",
                "argv": ["ls"]
            }),
        };
        let decision = engine.decide(&request);
        assert!(matches!(decision, PolicyDecision::Ask { .. }));
    }

    #[test]
    fn asks_shell_exec_with_no_workspace_root() {
        let engine = PolicyEngine::for_workspace("");
        let request = ToolRequest {
            run_id: "r1".into(),
            tool: "shell.exec".into(),
            input: serde_json::json!({
                "cwd": "/tmp",
                "argv": ["ls"]
            }),
        };
        let decision = engine.decide(&request);
        assert!(matches!(decision, PolicyDecision::Ask { .. }));
    }

    #[test]
    fn asks_shell_exec_when_cwd_missing() {
        let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
        let request = ToolRequest {
            run_id: "r1".into(),
            tool: "shell.exec".into(),
            input: serde_json::json!({ "argv": ["ls"] }),
        };
        let decision = engine.decide(&request);
        assert!(matches!(decision, PolicyDecision::Ask { .. }));
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
            "browser.navigate",
            "browser.wait",
            "browser.screenshot",
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
