use std::time::{Duration, Instant};

use serde::Serialize;

#[allow(dead_code)]
pub const RESTART_BACKOFF_MS: &[u64] = &[200, 1_000, 5_000, 30_000];
#[allow(dead_code)]
pub const MAX_RESTART_ATTEMPTS: u32 = 4;
#[allow(dead_code)]
pub const HEALTHY_RESET_AFTER: Duration = Duration::from_secs(600);

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SupervisorState {
    Starting,
    Running { since_ms: u128, pid: u32 },
    Restarting {
        attempt: u32,
        next_retry_ms: u128,
        last_error: String,
    },
    Faulted {
        reason: String,
        attempt_count: u32,
        last_error: String,
    },
    Stopping,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorStatus {
    pub state: SupervisorState,
    pub gateway_log: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug)]
pub struct RestartTracker {
    attempts: u32,
    last_restart_at: Option<Instant>,
}

#[allow(dead_code)]
impl RestartTracker {
    pub fn new() -> Self {
        Self { attempts: 0, last_restart_at: None }
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    pub fn record_failure(&mut self, now: Instant) {
        if let Some(prev) = self.last_restart_at {
            if now.duration_since(prev) > HEALTHY_RESET_AFTER {
                self.attempts = 0;
            }
        }
        self.attempts += 1;
        self.last_restart_at = Some(now);
    }

    pub fn should_give_up(&self) -> bool {
        self.attempts >= MAX_RESTART_ATTEMPTS
    }

    pub fn next_backoff(&self) -> Option<Duration> {
        if self.should_give_up() {
            return None;
        }
        let idx = (self.attempts as usize).saturating_sub(1);
        let ms = RESTART_BACKOFF_MS.get(idx).copied().unwrap_or(30_000);
        Some(Duration::from_millis(ms))
    }
}

impl Default for RestartTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_failure_uses_first_backoff() {
        let mut tr = RestartTracker::new();
        tr.record_failure(Instant::now());
        assert_eq!(tr.next_backoff(), Some(Duration::from_millis(200)));
    }

    #[test]
    fn fourth_failure_uses_30s_then_gives_up() {
        let mut tr = RestartTracker::new();
        let now = Instant::now();
        for _ in 0..3 {
            tr.record_failure(now);
        }
        assert_eq!(tr.next_backoff(), Some(Duration::from_millis(5_000)));
        tr.record_failure(now);
        assert!(tr.should_give_up());
        assert_eq!(tr.next_backoff(), None);
    }

    #[test]
    fn healthy_run_resets_counter() {
        let mut tr = RestartTracker::new();
        let t0 = Instant::now() - Duration::from_secs(700);
        tr.record_failure(t0); // attempt 1
        tr.record_failure(Instant::now()); // > 10 min later → reset, then count to 1
        assert_eq!(tr.attempts(), 1);
    }
}
