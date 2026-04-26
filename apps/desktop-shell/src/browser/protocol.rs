use serde::{Deserialize, Serialize};
use serde_json::Value;

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPairingToken {
    pub token: String,
    pub expires_at_unix_ms: u64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum BrowserRelayMessage {
    #[serde(rename = "Extension.hello")]
    ExtensionHello {
        protocol_version: u32,
        extension_version: String,
        pairing_token: String,
    },
    #[serde(rename = "Browser.tabs")]
    BrowserTabs { tabs: Vec<BrowserTab> },
    #[serde(rename = "Browser.actionResult")]
    BrowserActionResult {
        request_id: String,
        ok: bool,
        value: Value,
    },
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: u64,
    pub title: String,
    pub url: String,
    pub active: bool,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_extension_hello_message() {
        let message: BrowserRelayMessage = serde_json::from_str(
            r#"{"method":"Extension.hello","params":{"protocol_version":1,"extension_version":"0.1.0","pairing_token":"abc"}}"#,
        )
        .expect("message should parse");

        assert_eq!(
            message,
            BrowserRelayMessage::ExtensionHello {
                protocol_version: 1,
                extension_version: "0.1.0".to_string(),
                pairing_token: "abc".to_string(),
            }
        );
    }

    #[test]
    fn serializes_browser_tabs_message() {
        let message = BrowserRelayMessage::BrowserTabs {
            tabs: vec![BrowserTab {
                id: 12,
                title: "Example".to_string(),
                url: "https://example.test/".to_string(),
                active: true,
            }],
        };

        let value = serde_json::to_value(message).expect("message should serialize");

        assert_eq!(
            value,
            json!({
                "method": "Browser.tabs",
                "params": {
                    "tabs": [{
                        "id": 12,
                        "title": "Example",
                        "url": "https://example.test/",
                        "active": true
                    }]
                }
            })
        );
    }

    #[test]
    fn serializes_browser_action_result_message() {
        let message = BrowserRelayMessage::BrowserActionResult {
            request_id: "request-1".to_string(),
            ok: true,
            value: json!({ "text": "page text" }),
        };

        let value = serde_json::to_value(message).expect("message should serialize");

        assert_eq!(
            value,
            json!({
                "method": "Browser.actionResult",
                "params": {
                    "request_id": "request-1",
                    "ok": true,
                    "value": { "text": "page text" }
                }
            })
        );
    }

    #[test]
    fn serializes_pairing_token_for_desktop_status() {
        let token = BrowserPairingToken {
            token: "abc".to_string(),
            expires_at_unix_ms: 1_800_000_000_000,
        };

        let value = serde_json::to_value(token).expect("token should serialize");

        assert_eq!(
            value,
            json!({
                "token": "abc",
                "expiresAtUnixMs": 1_800_000_000_000u64
            })
        );
    }

    #[test]
    fn rejects_unknown_relay_method() {
        let error = serde_json::from_value::<BrowserRelayMessage>(json!({
            "method": "Browser.control",
            "params": {}
        }))
        .expect_err("unknown relay method should be rejected");

        assert!(error.to_string().contains("unknown variant"));
    }
}
