mod agent_pack;
mod agent_store;
mod auth;
mod browser;
mod commands;
mod gateway_client;
mod runtime;
mod sidecar;
mod single_instance;
mod state;
mod supervisor;
mod tool_callback;
mod workspace_store;

use std::{path::PathBuf, time::Duration};

use anyhow::{Context, Result};
use chrono::Utc;
use state::AppState;
use supervisor::{
    signal_gateway_shutdown, spawn_gateway, RestartTracker, RunningGateway, SpawnSpec,
    SupervisorState, SupervisorStatus,
};
use vulture_core::{PortBinding, RuntimeDescriptor, API_VERSION};

fn vulture_root() -> PathBuf {
    let home = std::env::var_os("HOME").expect("HOME must be set");
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Vulture")
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let root = vulture_root();
    std::fs::create_dir_all(&root).context("create vulture root")?;

    // 1. Single instance lock — held for life of process via this binding.
    let _instance_lock = single_instance::InstanceLock::acquire(root.join("lock"))
        .context("another Vulture instance is already running")?;

    // 2. Token + ports.
    let token = runtime::generate_token();
    let gateway_port = runtime::pick_free_port(4099, 100)?;
    let shell_port = runtime::pick_free_port(4199, 100)?;

    // 3. Shell HTTP callback server (held for the run; Drop on exit).
    let _shell_server = tool_callback::serve(shell_port).await?;

    // 4. Write runtime.json.
    let runtime_path = root.join("runtime.json");
    let descriptor = RuntimeDescriptor {
        api_version: API_VERSION.to_string(),
        gateway: PortBinding { port: gateway_port },
        shell: PortBinding { port: shell_port },
        token: token.clone(),
        pid: std::process::id(),
        started_at: now_iso(),
        shell_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    runtime::write_runtime_json(&runtime_path, &descriptor)?;

    // 5. App state.
    let app_state = AppState::new_for_root(&root)
        .context("failed to initialize Vulture desktop state")?;
    app_state.set_runtime_descriptor(descriptor.clone());

    // 6. Spawn Bun gateway as a background task with restart loop.
    let spawn_spec = SpawnSpec {
        bun_bin: PathBuf::from("bun"),
        gateway_entry: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/gateway/src/main.ts")
            .canonicalize()
            .context("resolve gateway entry path")?,
        workdir: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .context("resolve repo root")?,
        gateway_port,
        shell_port,
        token,
        shell_pid: std::process::id(),
        profile_dir: root.join("profiles").join("default"),
    };
    let restart_signal = app_state.restart_signal();
    let shutdown_signal = app_state.shutdown_signal();
    let status_handle = app_state.supervisor_status_handle();
    let supervisor_handle = tokio::spawn(supervisor_loop(
        spawn_spec,
        restart_signal,
        shutdown_signal.clone(),
        status_handle,
    ));

    // 7. Tauri webview — keeps every existing command + adds the 5 new system ones.
    let app = tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::start_mock_run,
            commands::start_agent_run,
            commands::get_profile,
            commands::list_agents,
            commands::get_agent,
            commands::save_agent,
            commands::delete_agent,
            commands::list_workspaces,
            commands::save_workspace,
            commands::delete_workspace,
            commands::get_openai_auth_status,
            commands::set_openai_api_key,
            commands::clear_openai_api_key,
            commands::start_codex_login,
            commands::get_browser_status,
            commands::start_browser_pairing,
            // Phase 1 additions:
            commands::get_runtime_info,
            commands::open_log_dir,
            commands::open_profile_dir,
            commands::get_supervisor_status,
            commands::restart_gateway,
        ])
        .build(tauri::generate_context!())
        .context("failed to build Tauri app")?;

    let exit_signal = shutdown_signal.clone();
    app.run(move |_app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            // Tell the supervisor to SIGTERM the gateway and unwind.
            exit_signal.notify_one();
        }
    });

    // 8. Cleanup — tauri's run() returned, app is exiting. Wait briefly for
    //    the supervisor to finish unwinding, then remove runtime.json.
    let _ = tokio::time::timeout(Duration::from_secs(7), supervisor_handle).await;
    runtime::remove_runtime_json(&runtime_path);
    Ok(())
}

/// Long-running supervisor: spawn the gateway, publish status to AppState,
/// and react to crashes / restart requests / shutdown requests.
async fn supervisor_loop(
    spawn_spec: SpawnSpec,
    restart_signal: std::sync::Arc<tokio::sync::Notify>,
    shutdown_signal: std::sync::Arc<tokio::sync::Notify>,
    status: std::sync::Arc<std::sync::RwLock<SupervisorStatus>>,
) {
    let mut tracker = RestartTracker::new();

    loop {
        let running: RunningGateway = match spawn_gateway(&spawn_spec).await {
            Ok(r) => {
                eprintln!("[supervisor] gateway READY on {}", r.reported_port);
                publish(
                    &status,
                    SupervisorStatus {
                        state: SupervisorState::Running {
                            since: now_iso(),
                            pid: r.child.id().unwrap_or(0),
                        },
                        gateway_log: None,
                    },
                );
                tracker = RestartTracker::new();
                r
            }
            Err(err) => {
                eprintln!("[supervisor] spawn failed: {err:#}");
                tracker.record_failure(std::time::Instant::now());
                if tracker.should_give_up() {
                    finalize_faulted(&status, &tracker, &err);
                    break;
                }
                let backoff = tracker
                    .next_backoff()
                    .expect("not give-up implies Some backoff");
                publish(
                    &status,
                    SupervisorStatus {
                        state: SupervisorState::Restarting {
                            attempt: tracker.attempts(),
                            next_retry_at: now_plus_iso(backoff),
                            last_error: format!("{err:#}"),
                        },
                        gateway_log: None,
                    },
                );
                if wait_with_signals(backoff, &restart_signal, &shutdown_signal).await
                    == WaitOutcome::Shutdown
                {
                    publish(
                        &status,
                        SupervisorStatus {
                            state: SupervisorState::Stopping,
                            gateway_log: None,
                        },
                    );
                    break;
                }
                continue;
            }
        };

        let mut child = running.child;
        let outcome = tokio::select! {
            result = child.wait() => Outcome::ChildExited(format!("{result:?}")),
            _ = restart_signal.notified() => Outcome::Restart,
            _ = shutdown_signal.notified() => Outcome::Shutdown,
        };

        match outcome {
            Outcome::ChildExited(detail) => {
                eprintln!("[supervisor] gateway exited: {detail}");
                tracker.record_failure(std::time::Instant::now());
                if tracker.should_give_up() {
                    finalize_faulted_with_message(
                        &status,
                        &tracker,
                        format!("gateway exited: {detail}"),
                    );
                    break;
                }
                let backoff = tracker
                    .next_backoff()
                    .expect("not give-up implies Some backoff");
                publish(
                    &status,
                    SupervisorStatus {
                        state: SupervisorState::Restarting {
                            attempt: tracker.attempts(),
                            next_retry_at: now_plus_iso(backoff),
                            last_error: detail,
                        },
                        gateway_log: None,
                    },
                );
                if wait_with_signals(backoff, &restart_signal, &shutdown_signal).await
                    == WaitOutcome::Shutdown
                {
                    publish(
                        &status,
                        SupervisorStatus {
                            state: SupervisorState::Stopping,
                            gateway_log: None,
                        },
                    );
                    break;
                }
            }
            Outcome::Restart => {
                eprintln!("[supervisor] restart signaled — terminating gateway");
                signal_gateway_shutdown(&mut child).await;
                tracker = RestartTracker::new();
            }
            Outcome::Shutdown => {
                eprintln!("[supervisor] shutdown signaled — terminating gateway");
                publish(
                    &status,
                    SupervisorStatus {
                        state: SupervisorState::Stopping,
                        gateway_log: None,
                    },
                );
                signal_gateway_shutdown(&mut child).await;
                break;
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum WaitOutcome {
    BackoffElapsed,
    Restart,
    Shutdown,
}

#[derive(Debug)]
enum Outcome {
    ChildExited(String),
    Restart,
    Shutdown,
}

async fn wait_with_signals(
    backoff: Duration,
    restart_signal: &tokio::sync::Notify,
    shutdown_signal: &tokio::sync::Notify,
) -> WaitOutcome {
    tokio::select! {
        _ = tokio::time::sleep(backoff) => WaitOutcome::BackoffElapsed,
        _ = restart_signal.notified() => WaitOutcome::Restart,
        _ = shutdown_signal.notified() => WaitOutcome::Shutdown,
    }
}

fn publish(status: &std::sync::RwLock<SupervisorStatus>, next: SupervisorStatus) {
    *status.write().expect("supervisor status lock poisoned") = next;
}

fn finalize_faulted(
    status: &std::sync::RwLock<SupervisorStatus>,
    tracker: &RestartTracker,
    err: &anyhow::Error,
) {
    finalize_faulted_with_message(status, tracker, format!("{err:#}"));
}

fn finalize_faulted_with_message(
    status: &std::sync::RwLock<SupervisorStatus>,
    tracker: &RestartTracker,
    detail: String,
) {
    eprintln!(
        "[supervisor] FAULTED after {} attempts: {detail}",
        tracker.attempts()
    );
    publish(
        status,
        SupervisorStatus {
            state: SupervisorState::Faulted {
                reason: "gateway exceeded max restart attempts".to_string(),
                attempt_count: tracker.attempts(),
                last_error: detail,
            },
            gateway_log: None,
        },
    );
}

fn now_plus_iso(delay: Duration) -> String {
    let chrono_delay = chrono::Duration::from_std(delay).unwrap_or(chrono::Duration::zero());
    (Utc::now() + chrono_delay).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
