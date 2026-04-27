use serde::Serialize;
use tauri::State;
use tokio::sync::oneshot;
use vulture_core::RuntimeDescriptor;

use crate::{
    auth::{unified_auth_status, AuthStatusView, OpenAiAuthStatus, SetOpenAiApiKeyRequest},
    codex_auth::{
        creds_from_token_response, delete_store, exchange_authorization_code, open_browser,
        read_store, start_callback_server, write_store, CallbackResult, Pkce, AUTHORIZE_URL,
        CLIENT_ID, SCOPE, TOKEN_URL,
    },
    state::AppState,
};

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGPTLoginStart {
    pub url: String,
    pub already_authenticated: bool,
}

#[tauri::command]
pub async fn start_chatgpt_login(state: State<'_, AppState>) -> Result<ChatGPTLoginStart, String> {
    let profile_dir = state.profile_dir();
    if let Ok(Some(_)) = read_store(&profile_dir) {
        return Ok(ChatGPTLoginStart {
            url: String::new(),
            already_authenticated: true,
        });
    }

    let pkce = Pkce::generate();

    let (tx, rx) = oneshot::channel::<CallbackResult>();
    let handle = start_callback_server(1455, tx)
        .await
        .map_err(|e| format!("start callback server: {e:#}"))?;
    let port = handle.bound_port;
    let redirect_uri = format!("http://localhost:{port}/auth/callback");

    let mut url = format!(
        "{AUTHORIZE_URL}?client_id={CLIENT_ID}&response_type=code&redirect_uri={}",
        urlencoding::encode(&redirect_uri),
    );
    url.push_str(&format!("&scope={}", urlencoding::encode(SCOPE)));
    url.push_str(&format!("&code_challenge={}", pkce.challenge));
    url.push_str("&code_challenge_method=S256");
    url.push_str(&format!("&state={}", pkce.state));

    open_browser(&url).map_err(|e| format!("open browser: {e:#}"))?;

    let callback = match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
        Ok(Ok(cb)) => cb,
        _ => {
            handle.shutdown().await;
            return Err("login timed out or cancelled".to_string());
        }
    };
    handle.shutdown().await;

    if callback.state != pkce.state {
        return Err("state mismatch (CSRF protection)".to_string());
    }

    let response =
        exchange_authorization_code(TOKEN_URL, &callback.code, &pkce.verifier, &redirect_uri)
            .await
            .map_err(|e| format!("token exchange: {e:#}"))?;

    let creds = creds_from_token_response(response, None)
        .map_err(|e| format!("creds from token: {e:#}"))?;

    write_store(&profile_dir, &creds).map_err(|e| format!("write store: {e:#}"))?;

    Ok(ChatGPTLoginStart {
        url,
        already_authenticated: false,
    })
}

#[tauri::command]
pub fn sign_out_chatgpt(state: State<'_, AppState>) -> Result<(), String> {
    delete_store(&state.profile_dir()).map_err(|e| format!("delete store: {e:#}"))
}

#[tauri::command]
pub fn get_auth_status(state: State<'_, AppState>) -> Result<AuthStatusView, String> {
    unified_auth_status(
        state.secret_store(),
        state.openai_secret_ref(),
        &state.profile_dir(),
    )
    .map_err(|e| format!("auth status: {e:#}"))
}
