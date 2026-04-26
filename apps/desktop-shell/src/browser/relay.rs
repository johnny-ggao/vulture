use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde::Serialize;
use uuid::Uuid;

const PAIRING_TOKEN_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRelayStatus {
    pub enabled: bool,
    pub paired: bool,
    pub pairing_token: Option<String>,
    pub relay_port: Option<u16>,
}

#[derive(Debug, Default)]
pub struct BrowserRelayState {
    paired: bool,
    pairing_token: Option<PairingToken>,
    relay_port: Option<u16>,
}

#[derive(Debug)]
struct PairingToken {
    value: String,
    expires_at: Instant,
}

impl BrowserRelayState {
    pub fn status(&self) -> BrowserRelayStatus {
        BrowserRelayStatus {
            enabled: self.relay_port.is_some(),
            paired: self.paired,
            pairing_token: self.current_pairing_token(),
            relay_port: self.relay_port,
        }
    }

    pub fn enable_pairing(&mut self, relay_port: u16) -> Result<BrowserRelayStatus> {
        if relay_port == 0 {
            return Err(anyhow!("browser relay port must be non-zero"));
        }

        self.paired = false;
        self.relay_port = Some(relay_port);
        self.pairing_token = Some(PairingToken {
            value: Uuid::new_v4().to_string(),
            expires_at: Instant::now() + PAIRING_TOKEN_TTL,
        });

        Ok(self.status())
    }

    #[allow(dead_code)]
    pub fn accept_token(&mut self, token: &str) -> bool {
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
        self.paired = true;
        true
    }

    fn current_pairing_token(&self) -> Option<String> {
        self.pairing_token
            .as_ref()
            .filter(|token| token.expires_at > Instant::now())
            .map(|token| token.value.clone())
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
}
