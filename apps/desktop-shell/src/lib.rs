//! Library facade for `vulture-desktop-shell` integration tests.
//!
//! Most logic lives in `main.rs` and is consumed only by the binary. This
//! module exposes the small subset that integration tests in `tests/` need.

pub mod gateway_client;
pub mod runtime;
