use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub id: ProfileId,
    pub name: String,
    pub openai_secret_ref: String,
    pub active_agent_id: String,
}

impl Profile {
    pub fn default_profile() -> Self {
        Self {
            id: ProfileId("default".to_string()),
            name: "Default".to_string(),
            openai_secret_ref: "vulture:profile:default:openai".to_string(),
            active_agent_id: "local-work-agent".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_default_profile_with_keychain_ref() {
        let profile = Profile::default_profile();

        assert_eq!(profile.id.0, "default");
        assert_eq!(profile.openai_secret_ref, "vulture:profile:default:openai");
        assert_eq!(profile.active_agent_id, "local-work-agent");
    }
}
