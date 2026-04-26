use vulture_tool_gateway::PolicyEngine;

pub struct AppState {
    policy_engine: PolicyEngine,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            policy_engine: PolicyEngine::default(),
        }
    }
}

impl AppState {
    pub fn policy_engine(&self) -> &PolicyEngine {
        &self.policy_engine
    }
}
