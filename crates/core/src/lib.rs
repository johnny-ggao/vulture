pub mod agent;
pub mod error;
pub mod paths;
pub mod profile;
pub mod storage;
pub mod workspace;

pub use agent::{AgentDefinition, AgentRecord, SUPPORTED_AGENT_TOOLS};
pub use error::{CoreError, CoreResult};
pub use paths::AppPaths;
pub use profile::{Profile, ProfileId};
pub use storage::StorageLayout;
pub use workspace::WorkspaceDefinition;
