use std::time::{Duration, Instant};

use serde::Serialize;

#[allow(dead_code)]
pub const RESTART_BACKOFF_MS: &[u64] = &[200, 1_000, 5_000, 30_000];
#[allow(dead_code)]
pub const MAX_RESTART_ATTEMPTS: u32 = 4;
#[allow(dead_code)]
pub const HEALTHY_RESET_AFTER: Duration = Duration::from_secs(600);

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SupervisorState {
    Starting,
    Running { since_ms: u128, pid: u32 },
    Restarting {
        attempt: u32,
        next_retry_ms: u128,
        last_error: String,
    },
    Faulted {
        reason: String,
        attempt_count: u32,
        last_error: String,
    },
    Stopping,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorStatus {
    pub state: SupervisorState,
    pub gateway_log: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug)]
pub struct RestartTracker {
    attempts: u32,
    last_restart_at: Option<Instant>,
}

#[allow(dead_code)]
impl RestartTracker {
    pub fn new() -> Self {
        Self { attempts: 0, last_restart_at: None }
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    pub fn record_failure(&mut self, now: Instant) {
        if let Some(prev) = self.last_restart_at {
            if now.duration_since(prev) > HEALTHY_RESET_AFTER {
                self.attempts = 0;
            }
        }
        self.attempts += 1;
        self.last_restart_at = Some(now);
    }

    pub fn should_give_up(&self) -> bool {
        self.attempts >= MAX_RESTART_ATTEMPTS
    }

    pub fn next_backoff(&self) -> Option<Duration> {
        if self.should_give_up() {
            return None;
        }
        let idx = (self.attempts as usize).saturating_sub(1);
        let ms = RESTART_BACKOFF_MS.get(idx).copied().unwrap_or(30_000);
        Some(Duration::from_millis(ms))
    }
}

impl Default for RestartTracker {
    fn default() -> Self {
        Self::new()
    }
}

use std::{
    path::PathBuf,
    process::Stdio,
};

use anyhow::{anyhow, Context, Result};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{timeout, Duration as TokioDuration},
};

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct SpawnSpec {
    pub bun_bin: PathBuf,
    pub gateway_entry: PathBuf,
    pub workdir: PathBuf,
    pub gateway_port: u16,
    pub shell_port: u16,
    pub token: String,
    pub shell_pid: u32,
    pub profile_dir: PathBuf,
}

#[allow(dead_code)]
#[derive(Debug)]
pub struct RunningGateway {
    pub child: Child,
    pub reported_port: u16,
}

#[allow(dead_code)]
const READY_TIMEOUT: TokioDuration = TokioDuration::from_secs(5);

#[allow(dead_code)]
pub async fn spawn_gateway(spec: &SpawnSpec) -> Result<RunningGateway> {
    let mut cmd = Command::new(&spec.bun_bin);
    cmd.arg(&spec.gateway_entry)
        .current_dir(&spec.workdir)
        .env("VULTURE_GATEWAY_PORT", spec.gateway_port.to_string())
        .env("VULTURE_GATEWAY_TOKEN", &spec.token)
        .env(
            "VULTURE_SHELL_CALLBACK_URL",
            format!("http://127.0.0.1:{}", spec.shell_port),
        )
        .env("VULTURE_SHELL_PID", spec.shell_pid.to_string())
        .env("VULTURE_PROFILE_DIR", &spec.profile_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn {}", spec.bun_bin.display()))?;

    let stdout = child.stdout.take().context("missing child stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    let port = timeout(READY_TIMEOUT, async {
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(rest) = line.strip_prefix("READY ") {
                let port: u16 = rest
                    .trim()
                    .parse()
                    .context("READY line did not contain a valid port")?;
                return Ok::<u16, anyhow::Error>(port);
            }
        }
        Err(anyhow!("gateway exited before printing READY"))
    })
    .await
    .map_err(|_| anyhow!("gateway did not print READY within {READY_TIMEOUT:?}"))??;

    Ok(RunningGateway {
        child,
        reported_port: port,
    })
}

#[allow(dead_code)]
pub async fn shutdown_gateway(mut running: RunningGateway) -> Result<()> {
    if let Some(pid) = running.child.id() {
        // SIGTERM: graceful shutdown on Unix
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    let waited = timeout(TokioDuration::from_secs(5), running.child.wait()).await;
    match waited {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e.into()),
        Err(_) => {
            running.child.kill().await.ok();
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_failure_uses_first_backoff() {
        let mut tr = RestartTracker::new();
        tr.record_failure(Instant::now());
        assert_eq!(tr.next_backoff(), Some(Duration::from_millis(200)));
    }

    #[test]
    fn fourth_failure_uses_30s_then_gives_up() {
        let mut tr = RestartTracker::new();
        let now = Instant::now();
        for _ in 0..3 {
            tr.record_failure(now);
        }
        assert_eq!(tr.next_backoff(), Some(Duration::from_millis(5_000)));
        tr.record_failure(now);
        assert!(tr.should_give_up());
        assert_eq!(tr.next_backoff(), None);
    }

    #[test]
    fn healthy_run_resets_counter() {
        let mut tr = RestartTracker::new();
        let t0 = Instant::now() - Duration::from_secs(700);
        tr.record_failure(t0); // attempt 1
        tr.record_failure(Instant::now()); // > 10 min later → reset, then count to 1
        assert_eq!(tr.attempts(), 1);
    }

    #[tokio::test]
    async fn spawn_waits_for_ready() {
        use std::io::Write;

        let dir = tempdir();
        let entry = dir.join("fake-gateway.ts");
        std::fs::File::create(&entry)
            .unwrap()
            .write_all(b"console.log('READY 12345'); setTimeout(()=>{}, 60_000);")
            .unwrap();

        let spec = SpawnSpec {
            bun_bin: PathBuf::from("bun"),
            gateway_entry: entry.clone(),
            workdir: dir.clone(),
            gateway_port: 12345,
            shell_port: 12346,
            token: "x".repeat(43),
            shell_pid: std::process::id(),
            profile_dir: dir.clone(),
        };

        let running = spawn_gateway(&spec).await.expect("spawn ready");
        assert_eq!(running.reported_port, 12345);
        shutdown_gateway(running).await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn spawn_times_out_when_no_ready() {
        use std::io::Write;

        let dir = tempdir();
        let entry = dir.join("silent-gateway.ts");
        std::fs::File::create(&entry)
            .unwrap()
            .write_all(b"setTimeout(()=>{}, 60_000);")
            .unwrap();

        let spec = SpawnSpec {
            bun_bin: PathBuf::from("bun"),
            gateway_entry: entry,
            workdir: dir.clone(),
            gateway_port: 0,
            shell_port: 0,
            token: "x".repeat(43),
            shell_pid: std::process::id(),
            profile_dir: dir.clone(),
        };

        let err = spawn_gateway(&spec).await.expect_err("should time out");
        assert!(err.to_string().contains("READY"));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn tempdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "vulture-supervisor-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
