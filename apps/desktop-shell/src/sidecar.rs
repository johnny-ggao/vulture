use std::{path::PathBuf, process::Stdio};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

pub async fn start_mock_run(input: String) -> Result<Vec<Value>> {
    let repo_root = repo_root();
    let sidecar_path = repo_root.join("apps/agent-sidecar/src/main.ts");

    let mut child = Command::new("bun")
        .arg(&sidecar_path)
        .current_dir(&repo_root)
        .env("VULTURE_AGENT_MODE", "mock")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to start sidecar at {}", sidecar_path.display()))?;

    let mut stdin = child
        .stdin
        .take()
        .context("sidecar stdin was not available")?;
    let stdout = child
        .stdout
        .take()
        .context("sidecar stdout was not available")?;
    let mut stderr = child
        .stderr
        .take()
        .context("sidecar stderr was not available")?;

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

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let bytes_read = reader
        .read_line(&mut line)
        .await
        .context("failed to read sidecar response")?;

    let status = child.wait().await.context("failed to wait for sidecar")?;
    let mut stderr_text = String::new();
    stderr
        .read_to_string(&mut stderr_text)
        .await
        .context("failed to read sidecar stderr")?;

    if bytes_read == 0 {
        bail!("sidecar exited without a response: {stderr_text}");
    }

    if !status.success() {
        bail!("sidecar exited with {status}: {stderr_text}");
    }

    events_from_response(&line)
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::events_from_response;

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
}
