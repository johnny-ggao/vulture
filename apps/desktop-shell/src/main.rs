mod commands;
mod sidecar;
mod state;

use state::AppState;

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![commands::start_mock_run])
        .run(tauri::generate_context!())
        .expect("failed to run Vulture desktop shell");
}
