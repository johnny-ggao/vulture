mod agent_pack;
mod agent_store;
mod auth;
mod browser;
mod commands;
mod sidecar;
mod state;
mod workspace_store;

use state::AppState;

fn main() {
    let app_state = AppState::new().expect("failed to initialize Vulture desktop state");

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
            commands::start_browser_pairing
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Vulture desktop shell");
}
