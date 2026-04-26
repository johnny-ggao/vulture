use serde_json::Value;
use tauri::State;

use crate::{sidecar, state::AppState};

#[tauri::command]
pub async fn start_mock_run(state: State<'_, AppState>, input: String) -> Result<Vec<Value>, String> {
    let _policy_engine = state.policy_engine();

    sidecar::start_mock_run(input)
        .await
        .map_err(|error| error.to_string())
}
