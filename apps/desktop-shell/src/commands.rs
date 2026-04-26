use serde_json::Value;
use tauri::State;

use crate::{sidecar, state::AppState};

#[tauri::command]
pub async fn start_mock_run(
    state: State<'_, AppState>,
    input: String,
) -> Result<Vec<Value>, String> {
    sidecar::start_mock_run(input, state.inner())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_profile(state: State<'_, AppState>) -> crate::state::ProfileView {
    state.profile().clone()
}

#[tauri::command]
pub fn get_browser_status(
    state: State<'_, AppState>,
) -> Result<crate::browser::relay::BrowserRelayStatus, String> {
    state.browser_status().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn start_browser_pairing(
    state: State<'_, AppState>,
) -> Result<crate::browser::relay::BrowserRelayStatus, String> {
    state.start_browser_pairing().map_err(|error| error.to_string())
}
