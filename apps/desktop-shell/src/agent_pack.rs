use std::{fs, path::Path};

use anyhow::{Context, Result};
use vulture_core::WorkspaceDefinition;

use crate::sidecar::AgentBridge;

const SOUL: &str = include_str!("../agent-packs/local-work/SOUL.md");
const IDENTITY: &str = include_str!("../agent-packs/local-work/IDENTITY.md");
const DEFAULT_AGENTS: &str = include_str!("../agent-packs/local-work/AGENTS.md");
const TOOLS: &str = include_str!("../agent-packs/local-work/TOOLS.md");
const USER: &str = include_str!("../agent-packs/local-work/USER.md");

pub fn assemble_codex_prompt(
    input: &str,
    agent: &AgentBridge,
    workspace: &WorkspaceDefinition,
) -> Result<String> {
    let instructions = assemble_agent_instructions(agent, workspace)?;

    Ok(format!(
        r#"{instructions}

## CURRENT TASK
Workspace: {workspace_name} ({workspace_path})

User task:
{input}
"#,
        instructions = instructions.trim(),
        workspace_name = workspace.name,
        workspace_path = workspace.path,
        input = input.trim(),
    ))
}

pub fn assemble_agent_instructions(
    agent: &AgentBridge,
    workspace: &WorkspaceDefinition,
) -> Result<String> {
    let workspace_agents = load_workspace_agents(Path::new(&workspace.path))?;
    let workspace_agents = workspace_agents
        .as_deref()
        .unwrap_or("No workspace AGENTS.md was found at the workspace root.");

    Ok(format!(
        r#"# Vulture Agent Pack

## SOUL.md
{soul}

## IDENTITY.md
{identity}

### Selected Agent
- id: {agent_id}
- name: {agent_name}
- description: {agent_description}
- model: {agent_model}
- reasoning: {agent_reasoning}

### Agent Instructions
{agent_instructions}

## USER.md
{user}

## AGENTS.md
### Default Agent Rules
{default_agents}

### Workspace AGENTS.md
{workspace_agents}

## TOOLS.md
{tools}

### Granted Tools
{granted_tools}
"#,
        soul = SOUL.trim(),
        identity = IDENTITY.trim(),
        agent_id = agent.id,
        agent_name = agent.name,
        agent_description = agent.description,
        agent_model = agent.model,
        agent_reasoning = agent.reasoning,
        agent_instructions = agent.instructions.trim(),
        user = USER.trim(),
        default_agents = DEFAULT_AGENTS.trim(),
        workspace_agents = workspace_agents.trim(),
        tools = TOOLS.trim(),
        granted_tools = agent.tools.join(", "),
    ))
}

pub fn corrective_prompt(original_task: &str, previous_output: &str) -> String {
    format!(
        r#"The previous response was a standby response instead of completing the task.

Do not say you are ready. Do not ask for another task. Complete the original task now.

Original task:
{original_task}

Previous response:
{previous_output}
"#,
        original_task = original_task.trim(),
        previous_output = previous_output.trim(),
    )
}

pub fn is_standby_response(output: &str) -> bool {
    let normalized = output.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }

    let standby_markers = [
        "你可以直接给我具体任务",
        "请告诉我需要做什么",
        "我已经准备好了",
        "i am ready",
        "i'm ready",
        "tell me what",
        "provide me with",
        "give me a task",
    ];

    standby_markers
        .iter()
        .any(|marker| normalized.contains(marker))
}

fn load_workspace_agents(workspace_path: &Path) -> Result<Option<String>> {
    let path = workspace_path.join("AGENTS.md");
    if !path.is_file() {
        return Ok(None);
    }

    fs::read_to_string(&path)
        .with_context(|| format!("failed to read workspace AGENTS.md at {}", path.display()))
        .map(Some)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use vulture_core::WorkspaceDefinition;

    use crate::sidecar::AgentBridge;

    use super::{assemble_agent_instructions, assemble_codex_prompt, is_standby_response};

    fn test_agent() -> AgentBridge {
        let workspace = test_workspace();
        AgentBridge {
            id: "local-work-agent".to_string(),
            name: "Local Work Agent".to_string(),
            description: "General local work assistant".to_string(),
            model: "gpt-5.4".to_string(),
            reasoning: "medium".to_string(),
            tools: vec!["shell.exec".to_string(), "browser.snapshot".to_string()],
            workspace,
            instructions: "Inspect the workspace and produce grounded results.".to_string(),
        }
    }

    fn test_workspace() -> WorkspaceDefinition {
        WorkspaceDefinition::new(
            "vulture".to_string(),
            "Vulture".to_string(),
            "/Users/johnny/Work/vulture".to_string(),
            Utc::now(),
        )
    }

    #[test]
    fn assembled_prompt_uses_agent_pack_sections() {
        let prompt = assemble_codex_prompt("总结这个 workspace", &test_agent(), &test_workspace())
            .expect("prompt should assemble");

        assert!(prompt.contains("## SOUL.md"));
        assert!(prompt.contains("## IDENTITY.md"));
        assert!(prompt.contains("## AGENTS.md"));
        assert!(prompt.contains("## TOOLS.md"));
        assert!(prompt.contains("## USER.md"));
        assert!(prompt.contains("禁止回复待命话术"));
        assert!(prompt.contains("User task:\n总结这个 workspace"));
    }

    #[test]
    fn assembled_agent_instructions_use_pack_without_current_task() {
        let instructions = assemble_agent_instructions(&test_agent(), &test_workspace())
            .expect("instructions should assemble");

        assert!(instructions.contains("## SOUL.md"));
        assert!(instructions.contains("## IDENTITY.md"));
        assert!(instructions.contains("## USER.md"));
        assert!(instructions.contains("禁止回复待命话术"));
        assert!(!instructions.contains("## CURRENT TASK"));
    }

    #[test]
    fn detects_standby_responses() {
        assert!(is_standby_response(
            "你可以直接给我具体任务，我会通过工具在本地完成。"
        ));
        assert!(is_standby_response("我已经准备好了，请告诉我需要做什么。"));
        assert!(!is_standby_response(
            "这个 workspace 包含 apps、crates 和 packages 三层结构。"
        ));
    }
}
