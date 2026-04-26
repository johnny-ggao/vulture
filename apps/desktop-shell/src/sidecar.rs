use std::{path::PathBuf, process::Stdio};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::{io::AsyncWriteExt, process::Command};
use vulture_tool_gateway::ToolRequest;

use crate::state::AppState;

pub async fn start_mock_run(input: String, state: &AppState) -> Result<Vec<Value>> {
    let repo_root = repo_root();
    let sidecar_path = repo_root.join("apps/agent-sidecar/src/main.ts");

    let mut child = Command::new("bun")
        .arg(&sidecar_path)
        .current_dir(&repo_root)
        .env("VULTURE_AGENT_MODE", "mock")
        .env("VULTURE_MOCK_TOOL_REQUEST", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to start sidecar at {}", sidecar_path.display()))?;

    let mut stdin = child
        .stdin
        .take()
        .context("sidecar stdin was not available")?;
    let request = json!({
        "id": "desktop-mock-run",
        "method": "run.create",
        "params": {
            "profileId": "default",
            "workspaceId": "local",
            "agentId": "local-work-agent",
            "input": input
        }
    });

    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .context("failed to write run.create request to sidecar")?;
    stdin
        .shutdown()
        .await
        .context("failed to close sidecar stdin")?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .await
        .context("failed to wait for sidecar")?;
    let stdout_text = String::from_utf8_lossy(&output.stdout);
    let stderr_text = String::from_utf8_lossy(&output.stderr);

    if first_stdout_line(&stdout_text).is_none() {
        bail!("sidecar exited without a response: {stderr_text}");
    }

    if !output.status.success() {
        bail!("sidecar exited with {}: {stderr_text}", output.status);
    }

    events_from_stdout(&stdout_text, state)
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .components()
        .collect()
}

fn events_from_response(line: &str) -> Result<Vec<Value>> {
    let response: Value = serde_json::from_str(line).context("sidecar returned invalid JSON")?;

    if let Some(error) = response.get("error") {
        bail!("sidecar returned error: {error}");
    }

    response
        .get("result")
        .and_then(|result| result.get("events"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| anyhow!("sidecar response missing result.events array"))
}

fn events_from_stdout(stdout: &str, state: &AppState) -> Result<Vec<Value>> {
    let mut final_events = None;

    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let response: Value =
            serde_json::from_str(line).context("sidecar returned invalid JSON")?;

        if response.get("method").and_then(Value::as_str) == Some("tool.request") {
            handle_tool_request(&response, state)?;
            continue;
        }

        if response
            .get("result")
            .and_then(|result| result.get("events"))
            .is_some()
        {
            final_events = Some(events_from_response(line)?);
        }
    }

    final_events.ok_or_else(|| anyhow!("sidecar response missing result.events array"))
}

fn handle_tool_request(message: &Value, state: &AppState) -> Result<()> {
    let params = message
        .get("params")
        .ok_or_else(|| anyhow!("tool.request missing params"))?;
    let run_id = params
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("tool.request missing params.runId"))?;
    let tool = params
        .get("tool")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("tool.request missing params.tool"))?;
    let input = params
        .get("input")
        .cloned()
        .ok_or_else(|| anyhow!("tool.request missing params.input"))?;
    let request = ToolRequest {
        run_id: run_id.to_string(),
        tool: tool.to_string(),
        input,
    };

    let _decision = state.decide_tool_request(&request)?;

    Ok(())
}

fn first_stdout_line(stdout: &str) -> Option<&str> {
    stdout.lines().find(|line| !line.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use rusqlite::Connection;
    use serde_json::json;

    use crate::state::AppState;

    use super::{events_from_response, events_from_stdout, first_stdout_line};

    #[test]
    fn extracts_events_from_success_response() {
        let response = json!({
            "id": "desktop-mock-run",
            "result": {
                "events": [
                    {
                        "runId": "run_1",
                        "type": "run_started",
                        "payload": { "agentId": "local-work-agent" },
                        "createdAt": "2026-04-26T00:00:00.000Z"
                    }
                ]
            }
        });

        let events = events_from_response(&response.to_string()).expect("events");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "run_started");
    }

    #[test]
    fn selects_first_non_empty_stdout_line() {
        let line =
            first_stdout_line("\n{\"id\":\"desktop-mock-run\",\"result\":{\"events\":[]}}\n");

        assert_eq!(
            line,
            Some("{\"id\":\"desktop-mock-run\",\"result\":{\"events\":[]}}")
        );
    }

    fn temp_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();

        std::env::temp_dir().join(format!(
            "vulture-desktop-sidecar-test-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn scans_tool_request_lines_before_final_events_and_audits_decision() {
        let root = temp_root();
        let state = AppState::new_for_root(&root).expect("app state should initialize");
        let audit_path = root.join("profiles/default/permissions/audit.sqlite");
        let stdout = [
            json!({
                "method": "tool.request",
                "params": {
                    "runId": "run_1",
                    "tool": "shell.exec",
                    "input": { "cwd": "/tmp", "argv": ["pwd"], "timeoutMs": 120000 }
                }
            })
            .to_string(),
            json!({
                "id": "desktop-mock-run",
                "result": {
                    "events": [
                        {
                            "runId": "run_1",
                            "type": "run_completed",
                            "payload": { "finalOutput": "done" },
                            "createdAt": "2026-04-26T00:00:00.000Z"
                        }
                    ]
                }
            })
            .to_string(),
        ]
        .join("\n");

        let events = events_from_stdout(&stdout, &state).expect("events should be returned");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "run_completed");
        assert!(audit_path.is_file());

        fs::remove_dir_all(root).expect("test root should be removable");
    }

    #[test]
    fn audits_browser_tool_requests_through_policy() {
        let root = temp_root();
        let state = AppState::new_for_root(&root).expect("app state should initialize");
        let audit_path = root.join("profiles/default/permissions/audit.sqlite");
        let stdout = [
            json!({
                "method": "tool.request",
                "params": {
                    "runId": "run_browser",
                    "tool": "browser.snapshot",
                    "input": { "tabId": 1 }
                }
            })
            .to_string(),
            json!({
                "id": "desktop-mock-run",
                "result": {
                    "events": [
                        {
                            "runId": "run_browser",
                            "type": "run_completed",
                            "payload": { "finalOutput": "done" },
                            "createdAt": "2026-04-26T00:00:00.000Z"
                        }
                    ]
                }
            })
            .to_string(),
        ]
        .join("\n");

        let events = events_from_stdout(&stdout, &state).expect("events should be returned");
        drop(state);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["runId"], "run_browser");

        let conn = Connection::open(&audit_path).expect("audit db should open");
        let policy_payload: String = conn
            .query_row(
                "SELECT payload FROM audit_events WHERE event_type = 'tool.policy_decision' ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("policy decision event should be persisted");
        let policy_payload: serde_json::Value =
            serde_json::from_str(&policy_payload).expect("policy payload should parse");

        assert_eq!(policy_payload["runId"], "run_browser");
        assert_eq!(policy_payload["tool"], "browser.snapshot");
        assert_eq!(
            policy_payload["decision"],
            json!({ "Ask": { "reason": "browser.snapshot requires browser approval" } })
        );

        fs::remove_dir_all(root).expect("test root should be removable");
    }
}
