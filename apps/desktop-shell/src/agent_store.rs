use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde::Serialize;
use vulture_core::{AgentDefinition, AgentRecord, WorkspaceDefinition};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model: String,
    pub reasoning: String,
    pub tools: Vec<String>,
    pub workspace: WorkspaceDefinition,
    pub instructions: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentRequest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model: String,
    pub reasoning: String,
    pub tools: Vec<String>,
    #[serde(default)]
    pub workspace: Option<WorkspaceDefinition>,
    pub instructions: String,
}

#[derive(Debug, Clone)]
pub struct AgentStore {
    root: PathBuf,
}

impl AgentStore {
    pub fn new(profile_dir: impl AsRef<Path>) -> Self {
        Self {
            root: profile_dir.as_ref().join("agents"),
        }
    }

    pub fn ensure_default_agent(&self) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        if !self
            .root
            .join("local-work-agent")
            .join("agent.json")
            .exists()
        {
            self.save_record(&AgentRecord::default_local_work_agent(Utc::now()))?;
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<AgentView>> {
        self.ensure_default_agent()?;
        let mut agents = Vec::new();

        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                agents.push(self.load(entry.file_name().to_string_lossy().as_ref())?);
            }
        }

        agents.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(agents)
    }

    pub fn load(&self, id: &str) -> Result<AgentView> {
        self.ensure_default_agent()?;
        let dir = self.root.join(id);
        let mut definition = self.load_definition(id)?;
        let instructions = fs::read_to_string(dir.join("instructions.md"))
            .with_context(|| format!("failed to read instructions for agent {id}"))?;
        let workspace = self.ensure_agent_workspace(&mut definition)?;
        let record = AgentRecord {
            definition: definition.clone(),
            instructions: instructions.clone(),
        };
        self.save_record(&record)?;

        Ok(AgentView {
            id: definition.id,
            name: definition.name,
            description: definition.description,
            model: definition.model,
            reasoning: definition.reasoning,
            tools: definition.tools,
            workspace,
            instructions,
        })
    }

    pub fn save(&self, request: SaveAgentRequest) -> Result<AgentView> {
        let now = Utc::now();
        let created_at = self
            .load_definition(&request.id)
            .map(|definition| definition.created_at)
            .unwrap_or(now);
        let record = AgentRecord {
            definition: AgentDefinition {
                id: request.id.clone(),
                name: request.name,
                description: request.description,
                model: request.model,
                reasoning: request.reasoning,
                tools: request.tools,
                workspace: request.workspace,
                created_at,
                updated_at: now,
            },
            instructions: request.instructions,
        };

        record.validate()?;
        self.save_record(&record)?;
        self.load(&record.definition.id)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let agents = self.list()?;
        if agents.len() <= 1 {
            return Err(anyhow!("cannot delete the last agent"));
        }

        fs::remove_dir_all(self.root.join(id))?;
        Ok(())
    }

    fn load_definition(&self, id: &str) -> Result<AgentDefinition> {
        let path = self.root.join(id).join("agent.json");
        serde_json::from_str(
            &fs::read_to_string(&path)
                .with_context(|| format!("failed to read agent metadata at {}", path.display()))?,
        )
        .with_context(|| format!("failed to parse agent metadata at {}", path.display()))
    }

    fn save_record(&self, record: &AgentRecord) -> Result<()> {
        let mut record = record.clone();
        let _workspace = self.ensure_agent_workspace(&mut record.definition)?;
        record.validate()?;
        let dir = self.root.join(&record.definition.id);
        fs::create_dir_all(&dir)?;
        fs::write(
            dir.join("agent.json"),
            serde_json::to_string_pretty(&record.definition)?,
        )?;
        fs::write(dir.join("instructions.md"), &record.instructions)?;
        Ok(())
    }

    fn ensure_agent_workspace(
        &self,
        definition: &mut AgentDefinition,
    ) -> Result<WorkspaceDefinition> {
        if let Some(workspace) = &definition.workspace {
            if Path::new(&workspace.path).is_dir() {
                return Ok(workspace.clone());
            }
        }

        let now = Utc::now();
        let workspace_path = self.root.join(&definition.id).join("workspace");
        fs::create_dir_all(&workspace_path)?;
        let workspace = WorkspaceDefinition::new(
            format!("{}-workspace", definition.id),
            format!("{} Workspace", definition.name),
            workspace_path.to_string_lossy().to_string(),
            now,
        );
        workspace.validate()?;
        definition.workspace = Some(workspace.clone());
        Ok(workspace)
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    fn temp_profile_dir() -> PathBuf {
        // UUID avoids nanos collision when tests run in parallel (cargo's
        // default test threads can sample SystemTime::now() in the same ns).
        std::env::temp_dir().join(format!(
            "vulture-agent-store-test-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ))
    }

    #[test]
    fn creates_default_agent() {
        let root = temp_profile_dir();
        let store = AgentStore::new(&root);

        let agents = store.list().expect("agents should list");

        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "local-work-agent");
        fs::remove_dir_all(root).expect("temp root should be removed");
    }

    #[test]
    fn saves_and_reloads_agent_instructions() {
        let root = temp_profile_dir();
        let store = AgentStore::new(&root);

        let saved = store
            .save(SaveAgentRequest {
                id: "coder".to_string(),
                name: "Coder".to_string(),
                description: "Writes code".to_string(),
                model: "gpt-5.4".to_string(),
                reasoning: "medium".to_string(),
                tools: vec!["shell.exec".to_string()],
                workspace: None,
                instructions: "Write code carefully.".to_string(),
            })
            .expect("agent should save");
        let loaded = store.load(&saved.id).expect("agent should load");

        assert_eq!(loaded.instructions, "Write code carefully.");
        fs::remove_dir_all(root).expect("temp root should be removed");
    }

    #[test]
    fn loaded_agent_has_private_workspace() {
        let root = temp_profile_dir();
        let store = AgentStore::new(&root);

        let agent = store.load("local-work-agent").expect("agent should load");

        assert_eq!(agent.workspace.id, "local-work-agent-workspace");
        assert!(agent
            .workspace
            .path
            .ends_with("agents/local-work-agent/workspace"));
        assert!(Path::new(&agent.workspace.path).is_dir());
        fs::remove_dir_all(root).expect("temp root should be removed");
    }

    #[test]
    fn refuses_to_delete_last_agent() {
        let root = temp_profile_dir();
        let store = AgentStore::new(&root);

        let error = store
            .delete("local-work-agent")
            .expect_err("last agent delete should fail");

        assert_eq!(error.to_string(), "cannot delete the last agent");
        fs::remove_dir_all(root).expect("temp root should be removed");
    }
}
