mod agent_pack;
mod agent_store;
mod auth;
mod browser;
mod commands;
mod runtime;
mod sidecar;
mod single_instance;
mod state;
mod supervisor;
mod tool_callback;
mod workspace_store;

use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::Utc;
use state::AppState;
use vulture_core::{PortBinding, RuntimeDescriptor, API_VERSION};

fn vulture_root() -> PathBuf {
    let home = std::env::var_os("HOME").expect("HOME must be set");
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Vulture")
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
        started_at: Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        shell_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    runtime::write_runtime_json(&runtime_path, &descriptor)?;

    // 5. App state.
    let app_state = AppState::new_for_root(&root)
        .context("failed to initialize Vulture desktop state")?;
    app_state.set_runtime_descriptor(descriptor.clone());

    // 6. Spawn Bun gateway as a background task.
    //    Phase 1: no restart loop. Task 23 wires that.
    let spawn_spec = supervisor::SpawnSpec {
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
    let _supervisor_handle = tokio::spawn(async move {
        match supervisor::spawn_gateway(&spawn_spec).await {
            Ok(running) => {
                eprintln!(
                    "[supervisor] gateway running on port {}",
                    running.reported_port
                );
                let _ = running.child.wait_with_output().await;
                eprintln!("[supervisor] gateway exited");
            }
            Err(e) => {
                eprintln!("[supervisor] failed to spawn gateway: {e:#}");
            }
        }
    });

    // 7. Tauri webview — keeps every existing command + adds the 5 new system ones.
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("failed to run Vulture desktop shell");

    // 8. Cleanup
    runtime::remove_runtime_json(&runtime_path);
    Ok(())
}
