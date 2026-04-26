use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub api_version: String,
    pub gateway: PortBinding,
    pub shell: PortBinding,
    pub token: String,
    pub pid: u32,
    pub started_at: String,
    pub shell_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    pub port: u16,
}

pub const API_VERSION: &str = "v1";

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture matches the JSON the TS schema (packages/protocol/src/v1/runtime.ts) emits.
    const TS_FIXTURE: &str = r#"{
      "apiVersion": "v1",
      "gateway": { "port": 4099 },
      "shell": { "port": 4199 },
      "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "pid": 1234,
      "startedAt": "2026-04-26T00:00:00.000Z",
      "shellVersion": "0.1.0"
    }"#;

    #[test]
    fn deserializes_ts_fixture() {
        let parsed: RuntimeDescriptor =
            serde_json::from_str(TS_FIXTURE).expect("ts fixture should parse");

        assert_eq!(parsed.api_version, API_VERSION);
        assert_eq!(parsed.gateway.port, 4099);
        assert_eq!(parsed.shell.port, 4199);
        assert_eq!(parsed.token.len(), 43);
        assert_eq!(parsed.pid, 1234);
    }

    #[test]
    fn round_trips_through_json() {
        let original = RuntimeDescriptor {
            api_version: API_VERSION.to_string(),
            gateway: PortBinding { port: 4099 },
            shell: PortBinding { port: 4199 },
            token: "x".repeat(43),
            pid: 99,
            started_at: "2026-04-26T00:00:00.000Z".to_string(),
            shell_version: "0.1.0".to_string(),
        };

        let json = serde_json::to_string(&original).unwrap();
        let parsed: RuntimeDescriptor = serde_json::from_str(&json).unwrap();
        assert_eq!(original, parsed);
    }
}
