use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{timeout, Duration as TokioDuration},
};

pub const RESTART_BACKOFF_MS: &[u64] = &[200, 1_000, 5_000, 30_000];
pub const MAX_RESTART_ATTEMPTS: u32 = 4;
pub const HEALTHY_RESET_AFTER: Duration = Duration::from_secs(600);
const READY_TIMEOUT: TokioDuration = TokioDuration::from_secs(5);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SupervisorState {
    Starting,
    Running {
        since: String,
        pid: u32,
    },
    Restarting {
        attempt: u32,
        next_retry_at: String,
        last_error: String,
    },
    Faulted {
        reason: String,
        attempt_count: u32,
        last_error: String,
    },
    Stopping,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorStatus {
    pub state: SupervisorState,
    pub gateway_log: Option<String>,
}

#[derive(Debug, Default)]
pub struct RestartTracker {
    attempts: u32,
    last_restart_at: Option<Instant>,
}

impl RestartTracker {
    pub fn new() -> Self {
        Self::default()
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

#[derive(Clone, Debug)]
pub struct SpawnSpec {
    pub bun_bin: PathBuf,
    pub gateway_entry: PathBuf,
    pub workdir: PathBuf,
    pub gateway_port: u16,
    pub shell_port: u16,
    pub token: String,
    pub shell_pid: u32,
    pub profile_dir: Arc<RwLock<PathBuf>>,
    pub default_workspace: Option<PathBuf>,
}

#[derive(Debug)]
pub struct RunningGateway {
    pub child: Child,
    pub reported_port: u16,
}

pub async fn spawn_gateway(spec: &SpawnSpec) -> Result<RunningGateway> {
    let profile_dir = spec
        .profile_dir
        .read()
        .map_err(|_| anyhow!("profile dir lock poisoned"))?
        .clone();
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
        .env("VULTURE_PROFILE_DIR", profile_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(default_workspace) = &spec.default_workspace {
        cmd.env("VULTURE_DEFAULT_WORKSPACE", default_workspace);
    }

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

/// Send SIGTERM to the gateway PID and wait up to 5s for graceful exit;
/// SIGKILL fallback. The caller already holds the [`Child`] handle and is
/// responsible for awaiting it after this returns. This helper just sends
/// the signals — it does not consume the child.
pub async fn signal_gateway_shutdown(child: &mut Child) {
    if let Some(pid) = child.id() {
        // SIGTERM: graceful shutdown on Unix.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    if timeout(TokioDuration::from_secs(5), child.wait())
        .await
        .is_err()
    {
        // Graceful window elapsed — SIGKILL.
        let _ = child.kill().await;
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
            profile_dir: Arc::new(RwLock::new(dir.clone())),
            default_workspace: None,
        };

        let mut running = spawn_gateway(&spec).await.expect("spawn ready");
        assert_eq!(running.reported_port, 12345);
        signal_gateway_shutdown(&mut running.child).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn spawn_does_not_export_default_workspace() {
        use std::io::Write;

        let dir = tempdir();
        let env_file = dir.join("default-workspace-env.txt");
        let entry = dir.join("fake-gateway-env.ts");
        std::fs::File::create(&entry)
            .unwrap()
            .write_all(
                format!(
                    "await Bun.write('{}', process.env.VULTURE_DEFAULT_WORKSPACE ?? ''); console.log('READY 12345'); setTimeout(()=>{{}}, 60_000);",
                    env_file.display()
                )
                .as_bytes(),
            )
            .unwrap();

        let spec = SpawnSpec {
            bun_bin: PathBuf::from("bun"),
            gateway_entry: entry.clone(),
            workdir: dir.clone(),
            gateway_port: 12345,
            shell_port: 12346,
            token: "x".repeat(43),
            shell_pid: std::process::id(),
            profile_dir: Arc::new(RwLock::new(dir.clone())),
            default_workspace: None,
        };

        let mut running = spawn_gateway(&spec).await.expect("spawn ready");
        let value = std::fs::read_to_string(&env_file).unwrap();
        assert_eq!(value, "");
        signal_gateway_shutdown(&mut running.child).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn spawn_exports_default_workspace_when_spec_sets_it() {
        use std::io::Write;

        let dir = tempdir();
        let workspace = dir.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let env_file = dir.join("default-workspace-env.txt");
        let entry = dir.join("fake-gateway-env.ts");
        std::fs::File::create(&entry)
            .unwrap()
            .write_all(
                format!(
                    "await Bun.write('{}', process.env.VULTURE_DEFAULT_WORKSPACE ?? ''); console.log('READY 12345'); setTimeout(()=>{{}}, 60_000);",
                    env_file.display()
                )
                .as_bytes(),
            )
            .unwrap();

        let spec = SpawnSpec {
            bun_bin: PathBuf::from("bun"),
            gateway_entry: entry,
            workdir: dir.clone(),
            gateway_port: 12345,
            shell_port: 12346,
            token: "x".repeat(43),
            shell_pid: std::process::id(),
            profile_dir: Arc::new(RwLock::new(dir.clone())),
            default_workspace: Some(workspace.clone()),
        };

        let mut running = spawn_gateway(&spec).await.expect("spawn ready");
        let value = std::fs::read_to_string(&env_file).unwrap();
        assert_eq!(value, workspace.display().to_string());
        signal_gateway_shutdown(&mut running.child).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn spawn_does_not_force_memory_suggestions_env() {
        use std::io::Write;
        use std::sync::{Mutex, OnceLock};

        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let previous = std::env::var_os("VULTURE_MEMORY_SUGGESTIONS");
        std::env::set_var("VULTURE_MEMORY_SUGGESTIONS", "1");

        let dir = tempdir();
        let env_file = dir.join("memory-suggestions-env.txt");
        let entry = dir.join("fake-gateway-memory-env.ts");
        std::fs::File::create(&entry)
            .unwrap()
            .write_all(
                format!(
                    "await Bun.write('{}', process.env.VULTURE_MEMORY_SUGGESTIONS ?? ''); console.log('READY 12345'); setTimeout(()=>{{}}, 60_000);",
                    env_file.display()
                )
                .as_bytes(),
            )
            .unwrap();

        let spec = SpawnSpec {
            bun_bin: PathBuf::from("bun"),
            gateway_entry: entry,
            workdir: dir.clone(),
            gateway_port: 12345,
            shell_port: 12346,
            token: "x".repeat(43),
            shell_pid: std::process::id(),
            profile_dir: Arc::new(RwLock::new(dir.clone())),
            default_workspace: None,
        };

        let mut running = spawn_gateway(&spec).await.expect("spawn ready");
        if let Some(value) = previous {
            std::env::set_var("VULTURE_MEMORY_SUGGESTIONS", value);
        } else {
            std::env::remove_var("VULTURE_MEMORY_SUGGESTIONS");
        }

        let value = std::fs::read_to_string(&env_file).unwrap();
        assert_eq!(value, "1");
        signal_gateway_shutdown(&mut running.child).await;
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
            profile_dir: Arc::new(RwLock::new(dir.clone())),
            default_workspace: None,
        };

        let err = spawn_gateway(&spec).await.expect_err("should time out");
        assert!(err.to_string().contains("READY"));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn tempdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "vulture-supervisor-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
