use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;

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
}
