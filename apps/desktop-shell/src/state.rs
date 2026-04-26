use vulture_tool_gateway::PolicyEngine;

#[derive(Default)]
pub struct AppState {
    policy_engine: PolicyEngine,
}

impl AppState {
    pub fn policy_engine(&self) -> &PolicyEngine {
        &self.policy_engine
    }
}
