use serde_json::Value;
use tauri::State;

use crate::{
    agent_store::{AgentView, SaveAgentRequest},
    auth::{OpenAiAuthStatus, SetOpenAiApiKeyRequest},
    sidecar,
    state::{AppState, ProfileView},
    workspace_store::SaveWorkspaceRequest,
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
pub fn get_profile(state: State<'_, AppState>) -> ProfileView {
    state.profile().clone()
}

#[tauri::command]
pub fn list_agents(state: State<'_, AppState>) -> Result<Vec<AgentView>, String> {
    state.list_agents().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_agent(state: State<'_, AppState>, id: String) -> Result<AgentView, String> {
    state.get_agent(&id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_agent(
    state: State<'_, AppState>,
    request: SaveAgentRequest,
) -> Result<AgentView, String> {
    state.save_agent(request).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_agent(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.delete_agent(&id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_workspaces(
    state: State<'_, AppState>,
) -> Result<Vec<vulture_core::WorkspaceDefinition>, String> {
    state.list_workspaces().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_workspace(
    state: State<'_, AppState>,
    request: SaveWorkspaceRequest,
) -> Result<vulture_core::WorkspaceDefinition, String> {
    state
        .save_workspace(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_workspace(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .delete_workspace(&id)
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
