use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;
use uuid::Uuid;

use super::protocol::BrowserTab;

const PAIRING_TOKEN_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRelayStatus {
    pub enabled: bool,
    pub paired: bool,
    pub pairing_token: Option<String>,
    pub relay_port: Option<u16>,
    pub extension_version: Option<String>,
    pub tab_count: usize,
    pub active_tab: Option<BrowserTab>,
}

#[derive(Default)]
pub struct BrowserRelayState {
    paired: bool,
    session_token: Option<String>,
    pairing_token: Option<PairingToken>,
    pending_actions: VecDeque<BrowserActionRequest>,
    action_waiters: HashMap<String, oneshot::Sender<BrowserActionResult>>,
    relay_port: Option<u16>,
    extension_version: Option<String>,
    tabs: Vec<BrowserTab>,
}

#[derive(Debug)]
struct PairingToken {
    value: String,
    expires_at: Instant,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionRequest {
    pub request_id: String,
    pub tool: String,
    pub input: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BrowserActionResult {
    pub ok: bool,
    pub value: Value,
}

impl BrowserRelayState {
    pub fn status(&mut self) -> BrowserRelayStatus {
        BrowserRelayStatus {
            enabled: self.relay_port.is_some(),
            paired: self.paired,
            pairing_token: self.current_pairing_token(),
            relay_port: self.relay_port,
            extension_version: self.extension_version.clone(),
            tab_count: self.tabs.len(),
            active_tab: self.tabs.iter().find(|tab| tab.active).cloned(),
        }
    }

    pub fn enable_pairing(&mut self, relay_port: u16) -> Result<BrowserRelayStatus> {
        if relay_port == 0 {
            return Err(anyhow!("browser relay port must be non-zero"));
        }

        self.paired = false;
        self.session_token = None;
        self.extension_version = None;
        self.tabs.clear();
        self.relay_port = Some(relay_port);
        self.pairing_token = Some(PairingToken {
            value: Uuid::new_v4().to_string(),
            expires_at: Instant::now() + PAIRING_TOKEN_TTL,
        });
        self.pending_actions.clear();
        self.action_waiters.clear();

        Ok(self.status())
    }

    #[allow(dead_code)]
    pub fn accept_token(&mut self, token: &str) -> bool {
        self.accept_token_with_extension(token, "")
    }

    pub fn accept_token_with_extension(&mut self, token: &str, extension_version: &str) -> bool {
        let Some(pairing_token) = self.pairing_token.as_ref() else {
            return false;
        };

        if pairing_token.expires_at <= Instant::now() {
            self.pairing_token = None;
            return false;
        }

        if pairing_token.value != token {
            return false;
        }

        self.pairing_token = None;
        self.session_token = Some(token.to_string());
        self.extension_version = if extension_version.trim().is_empty() {
            None
        } else {
            Some(extension_version.trim().to_string())
        };
        self.paired = true;
        true
    }

    pub fn update_tabs(&mut self, tabs: Vec<BrowserTab>) {
        self.tabs = tabs;
    }

    pub fn update_tabs_for_token(&mut self, token: &str, tabs: Vec<BrowserTab>) -> bool {
        if !self.is_authorized(token) {
            return false;
        }
        self.update_tabs(tabs);
        true
    }

    pub fn enqueue_action(
        &mut self,
        tool: String,
        input: Value,
    ) -> Result<(BrowserActionRequest, oneshot::Receiver<BrowserActionResult>)> {
        if !self.paired {
            return Err(anyhow!("browser extension is not paired"));
        }

        let request = BrowserActionRequest {
            request_id: format!("browser-{}", Uuid::new_v4()),
            tool,
            input,
        };
        let (tx, rx) = oneshot::channel();
        self.action_waiters.insert(request.request_id.clone(), tx);
        self.pending_actions.push_back(request.clone());
        Ok((request, rx))
    }

    pub fn take_next_action(&mut self, token: &str) -> Result<Option<BrowserActionRequest>> {
        if !self.is_authorized(token) {
            return Err(anyhow!("browser extension is not paired"));
        }

        Ok(self.pending_actions.pop_front())
    }

    pub fn complete_action(
        &mut self,
        token: &str,
        request_id: &str,
        ok: bool,
        value: Value,
    ) -> bool {
        if !self.is_authorized(token) {
            return false;
        }

        let Some(waiter) = self.action_waiters.remove(request_id) else {
            return false;
        };
        let _ = waiter.send(BrowserActionResult { ok, value });
        true
    }

    fn is_authorized(&self, token: &str) -> bool {
        self.paired && self.session_token.as_deref() == Some(token)
    }

    fn current_pairing_token(&mut self) -> Option<String> {
        let token = self.pairing_token.as_ref()?;

        if token.expires_at <= Instant::now() {
            self.pairing_token = None;
            return None;
        }

        Some(token.value.clone())
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    #[test]
    fn enable_pairing_creates_one_time_token() {
        let mut state = BrowserRelayState::default();

        let status = state
            .enable_pairing(9444)
            .expect("non-zero relay port should enable pairing");
        let token = status
            .pairing_token
            .as_deref()
            .expect("pairing token should be returned");

        assert!(status.enabled);
        assert!(!status.paired);
        assert_eq!(status.relay_port, Some(9444));
        assert!(!token.is_empty());
        Uuid::parse_str(token).expect("pairing token should be a UUID");
        assert!(state.accept_token(token));
        assert!(!state.accept_token(token));
        assert_eq!(state.status().pairing_token, None);
    }

    #[test]
    fn enable_pairing_rejects_zero_port() {
        let mut state = BrowserRelayState::default();

        let error = state
            .enable_pairing(0)
            .expect_err("zero relay port should be rejected");

        assert!(error.to_string().contains("non-zero"));
    }

    #[test]
    fn expired_pairing_token_is_hidden_and_rejected() {
        let mut state = BrowserRelayState {
            paired: false,
            session_token: None,
            pairing_token: Some(PairingToken {
                value: "expired-token".to_string(),
                expires_at: Instant::now() - Duration::from_secs(1),
            }),
            pending_actions: Default::default(),
            action_waiters: Default::default(),
            relay_port: Some(9444),
            extension_version: None,
            tabs: Vec::new(),
        };

        let status = state.status();

        assert!(status.enabled);
        assert!(!status.paired);
        assert_eq!(status.pairing_token, None);
        assert!(!state.accept_token("expired-token"));
        assert!(state.pairing_token.is_none());
    }

    #[tokio::test]
    async fn paired_extension_can_take_and_complete_browser_action() {
        let mut state = BrowserRelayState::default();
        let status = state.enable_pairing(9444).expect("pairing should start");
        let token = status.pairing_token.expect("token should be present");
        assert!(state.accept_token(&token));

        let (request, result) = state
            .enqueue_action("browser.snapshot".to_string(), serde_json::json!({}))
            .expect("paired relay should accept actions");
        assert_eq!(request.tool, "browser.snapshot");

        let taken = state
            .take_next_action(&token)
            .expect("authorized token should take an action")
            .expect("pending action should exist");
        assert_eq!(taken.request_id, request.request_id);

        assert!(state.complete_action(
            &token,
            &request.request_id,
            true,
            serde_json::json!({ "title": "Example" }),
        ));
        let result = result.await.expect("result should be delivered");
        assert!(result.ok);
        assert_eq!(result.value["title"], "Example");
    }

    #[test]
    fn status_reports_extension_and_active_tab() {
        let mut state = BrowserRelayState::default();
        let status = state.enable_pairing(9444).expect("pairing should start");
        let token = status.pairing_token.expect("token should be present");
        assert!(state.accept_token_with_extension(&token, "0.2.0"));

        state.update_tabs(vec![
            crate::browser::protocol::BrowserTab {
                id: 1,
                title: "Background".to_string(),
                url: "https://background.test/".to_string(),
                active: false,
            },
            crate::browser::protocol::BrowserTab {
                id: 2,
                title: "Active".to_string(),
                url: "https://active.test/".to_string(),
                active: true,
            },
        ]);

        let status = state.status();

        assert_eq!(status.extension_version.as_deref(), Some("0.2.0"));
        assert_eq!(status.tab_count, 2);
        assert_eq!(status.active_tab.as_ref().map(|tab| tab.id), Some(2));
    }
}
