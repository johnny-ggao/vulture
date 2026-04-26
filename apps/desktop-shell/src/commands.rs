use serde_json::Value;
use tauri::State;
use vulture_core::RuntimeDescriptor;

use crate::{
    auth::{self, CodexLoginRequest, CodexLoginStart, OpenAiAuthStatus, SetOpenAiApiKeyRequest},
    sidecar,
    state::AppState,
};

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
pub async fn start_agent_run(
    state: State<'_, AppState>,
    request: sidecar::StartAgentRunRequest,
) -> Result<Vec<Value>, String> {
    sidecar::start_agent_run(request, state.inner())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_openai_auth_status(state: State<'_, AppState>) -> Result<OpenAiAuthStatus, String> {
    state
        .openai_auth_status()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_openai_api_key(
    state: State<'_, AppState>,
    request: SetOpenAiApiKeyRequest,
) -> Result<OpenAiAuthStatus, String> {
    state
        .set_openai_api_key(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_openai_api_key(state: State<'_, AppState>) -> Result<OpenAiAuthStatus, String> {
    state
        .clear_openai_api_key()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn start_codex_login(
    request: Option<CodexLoginRequest>,
) -> Result<CodexLoginStart, String> {
    auth::start_codex_login(request.unwrap_or_default())
        .await
        .map_err(|error| error.to_string())
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
    state
        .start_browser_pairing()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_runtime_info(state: State<'_, AppState>) -> Result<RuntimeDescriptor, String> {
    state
        .runtime_descriptor()
        .ok_or_else(|| "runtime not yet initialized".to_string())
}

#[tauri::command]
pub fn open_log_dir(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.profile_dir().join("..").join("..").join("Logs/Vulture");
    open_in_finder(&dir)
}

#[tauri::command]
pub fn open_profile_dir(state: State<'_, AppState>) -> Result<(), String> {
    open_in_finder(&state.profile_dir())
}

#[tauri::command]
pub fn get_supervisor_status(
    state: State<'_, AppState>,
) -> Result<crate::supervisor::SupervisorStatus, String> {
    Ok(state.supervisor_status())
}

#[tauri::command]
pub fn restart_gateway(state: State<'_, AppState>) -> Result<(), String> {
    state.request_supervisor_restart();
    Ok(())
}

fn open_in_finder(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    Ok(())
}
