use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use std::net::TcpListener;

#[allow(dead_code)]
pub const TOKEN_BYTES: usize = 32;
#[allow(dead_code)]
pub const TOKEN_B64_LEN: usize = 43; // 32 bytes URL-safe base64, no padding

#[allow(dead_code)]
pub fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Linear scan starting at `start`, trying up to `window` ports.
/// Returns the first free port. SECURITY: binds 127.0.0.1 only.
#[allow(dead_code)]
pub fn pick_free_port(start: u16, window: u16) -> anyhow::Result<u16> {
    for offset in 0..window {
        let port = start.saturating_add(offset);
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(anyhow::anyhow!(
        "no free port in 127.0.0.1:{start}-{}",
        start.saturating_add(window).saturating_sub(1)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn token_has_expected_length() {
        let t = generate_token();
        assert_eq!(t.len(), TOKEN_B64_LEN);
    }

    #[test]
    fn tokens_are_url_safe_base64() {
        let t = generate_token();
        for ch in t.chars() {
            assert!(
                ch.is_ascii_alphanumeric() || ch == '-' || ch == '_',
                "unexpected char: {ch}"
            );
        }
    }

    #[test]
    fn tokens_are_unique_across_many_calls() {
        let mut seen = HashSet::new();
        for _ in 0..1024 {
            assert!(seen.insert(generate_token()), "duplicate token");
        }
    }

    #[test]
    fn picks_a_free_port_in_range() {
        let port = pick_free_port(40000, 100).expect("should find free port");
        assert!((40000..40100).contains(&port));
    }

    #[test]
    fn skips_occupied_ports() {
        use std::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied = listener.local_addr().unwrap().port();
        let picked = pick_free_port(occupied, 5).expect("falls through occupied");
        assert_ne!(picked, occupied);
    }
}
