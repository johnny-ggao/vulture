use std::os::unix::fs::PermissionsExt;

use vulture_core::{PortBinding, RuntimeDescriptor, API_VERSION};
use vulture_desktop_shell::runtime;

#[test]
fn write_then_read_round_trip_preserves_mode_0600() {
    let dir = std::env::temp_dir().join(format!(
        "vulture-it-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("runtime.json");

    let descriptor = RuntimeDescriptor {
        api_version: API_VERSION.to_string(),
        gateway: PortBinding { port: 4099 },
        shell: PortBinding { port: 4199 },
        token: "x".repeat(43),
        pid: std::process::id(),
        started_at: chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        shell_version: "0.1.0".to_string(),
    };

    runtime::write_runtime_json(&path, &descriptor).unwrap();

    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);

    let read = runtime::read_runtime_json(&path).unwrap();
    assert_eq!(read, descriptor);

    std::fs::remove_dir_all(&dir).ok();
}
