use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellExecInput {
    pub cwd: String,
    pub argv: Vec<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_timeout_ms() -> u64 {
    120_000
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

pub async fn execute_shell(input: ShellExecInput) -> Result<ShellExecOutput> {
    if input.argv.is_empty() {
        return Err(anyhow!("argv must not be empty"));
    }
    // current_dir() that points to a non-existent path makes spawn fail with
    // a misleading "failed to spawn <bin>: No such file or directory" — the
    // ENOENT is from the chdir, not the binary lookup. Validate up front so
    // the model gets an actionable error.
    let cwd_path = std::path::Path::new(&input.cwd);
    if !cwd_path.is_dir() {
        return Err(anyhow!(
            "cwd does not exist or is not a directory: {}",
            input.cwd
        ));
    }
    let mut cmd = Command::new(&input.argv[0]);
    cmd.args(&input.argv[1..])
        .current_dir(&input.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().with_context(|| {
        format!(
            "failed to spawn {}",
            input.argv.first().cloned().unwrap_or_default()
        )
    })?;
    let stdout = child.stdout.take().context("missing stdout")?;
    let stderr = child.stderr.take().context("missing stderr")?;

    let exit_status = timeout(Duration::from_millis(input.timeout_ms), child.wait())
        .await
        .map_err(|_| anyhow!("shell.exec timed out after {} ms", input.timeout_ms))??;

    let mut stdout_buf = String::new();
    let mut stdout_reader = stdout;
    stdout_reader.read_to_string(&mut stdout_buf).await.ok();
    let mut stderr_buf = String::new();
    let mut stderr_reader = stderr;
    stderr_reader.read_to_string(&mut stderr_buf).await.ok();

    Ok(ShellExecOutput {
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code: exit_status.code().unwrap_or(-1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn echo_returns_stdout() {
        let out = execute_shell(ShellExecInput {
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            argv: vec!["echo".into(), "hello".into()],
            timeout_ms: 5_000,
        })
        .await
        .expect("echo should succeed");
        assert!(out.stdout.contains("hello"));
        assert_eq!(out.exit_code, 0);
    }

    #[tokio::test]
    async fn nonexistent_binary_errors() {
        let result = execute_shell(ShellExecInput {
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            argv: vec!["__definitely_no_such_binary_xyz__".into()],
            timeout_ms: 5_000,
        })
        .await;
        assert!(result.is_err());
    }
}
