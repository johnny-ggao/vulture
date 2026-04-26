mod commands;
mod sidecar;
mod state;

use state::AppState;

fn main() {
    let app_state = AppState::new().expect("failed to initialize Vulture desktop state");

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::start_mock_run,
            commands::get_profile
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Vulture desktop shell");
}
