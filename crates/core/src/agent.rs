pub fn is_slug(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_slug_ids() {
        assert!(is_slug("browser-researcher"));
        assert!(!is_slug("Browser Researcher"));
        assert!(!is_slug("-browser"));
        assert!(!is_slug("browser-"));
    }
}
