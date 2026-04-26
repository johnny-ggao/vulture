use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPairingToken {
    pub token: String,
    pub expires_at_unix_ms: u64,
}

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
}
