import { useEffect, useMemo, useState } from "react";
import type { Agent, AgentCoreFile, AgentCoreFilesResponse, AgentToolName, AgentToolPreset, ReasoningLevel } from "../api/agents";
import type { ToolCatalogGroup } from "../api/tools";
import { toolPolicyFromPreset, toolPolicyFromSelection } from "../api/tools";
import { ToolGroupSelector } from "./ToolGroupSelector";
import { Field, SectionCard } from "./components";

export interface AgentsPageProps {
  agents: ReadonlyArray<Agent>;
  selectedAgentId: string;
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  onCreate: () => void;
  onOpenChat: (id: string) => void;
  onSave: (id: string, patch: AgentConfigPatch) => Promise<void>;
  onListFiles: (id: string) => Promise<AgentCoreFilesResponse>;
  onLoadFile: (id: string, name: string) => Promise<string>;
  onSaveFile: (id: string, name: string, content: string) => Promise<void>;
}

export interface AgentConfigPatch {
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  tools: AgentToolName[];
  toolPreset: AgentToolPreset;
  toolInclude: AgentToolName[];
  toolExclude: AgentToolName[];
  skills?: string[] | null;
  instructions: string;
}

interface Draft {
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  tools: AgentToolName[];
  toolPreset: AgentToolPreset;
  toolInclude: AgentToolName[];
  toolExclude: AgentToolName[];
  skillsText: string;
  instructions: string;
}

export function AgentsPage(props: AgentsPageProps) {
  const [activeId, setActiveId] = useState(props.selectedAgentId || props.agents[0]?.id || "");
  const active = useMemo(
    () => props.agents.find((agent) => agent.id === activeId) ?? props.agents[0],
    [activeId, props.agents],
  );
  const [draft, setDraft] = useState<Draft>(() => draftFromAgent(active));
  const [saving, setSaving] = useState(false);
  const [coreFiles, setCoreFiles] = useState<AgentCoreFile[]>([]);
  const [corePath, setCorePath] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [fileStatus, setFileStatus] = useState("");
  const [fileBusy, setFileBusy] = useState(false);

  useEffect(() => {
    if (!active && props.agents[0]) setActiveId(props.agents[0].id);
  }, [active, props.agents]);

  useEffect(() => {
    setDraft(draftFromAgent(active));
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    setCoreFiles([]);
    setCorePath("");
    setSelectedFile("");
    setFileContent("");
    setFileStatus("");
    if (!active) return;
    (async () => {
      try {
        const result = await props.onListFiles(active.id);
        if (cancelled) return;
        setCoreFiles(result.files);
        setCorePath(result.corePath);
        setSelectedFile(result.files.find((file) => file.name === "AGENTS.md")?.name ?? result.files[0]?.name ?? "");
      } catch (cause) {
        if (!cancelled) setFileStatus(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active?.id]);

  useEffect(() => {
    let cancelled = false;
    setFileContent("");
    if (!active || !selectedFile) return;
    setFileBusy(true);
    setFileStatus("");
    (async () => {
      try {
        const content = await props.onLoadFile(active.id, selectedFile);
        if (!cancelled) setFileContent(content);
      } catch (cause) {
        if (!cancelled) setFileStatus(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setFileBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active?.id, selectedFile]);

  async function save() {
    if (!active || !draft.name.trim() || !draft.instructions.trim() || saving) return;
    setSaving(true);
    try {
      await props.onSave(active.id, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        model: draft.model.trim(),
        reasoning: draft.reasoning,
        tools: draft.tools,
        toolPreset: draft.toolPreset,
        toolInclude: draft.toolInclude,
        toolExclude: draft.toolExclude,
        skills: parseSkills(draft.skillsText),
        instructions: draft.instructions.trim(),
      });
    } finally {
      setSaving(false);
    }
  }

  async function saveCoreFile() {
    if (!active || !selectedFile || fileBusy) return;
    setFileBusy(true);
    setFileStatus("");
    try {
      await props.onSaveFile(active.id, selectedFile, fileContent);
      const result = await props.onListFiles(active.id);
      setCoreFiles(result.files);
      setCorePath(result.corePath);
      setFileStatus("已保存");
    } catch (cause) {
      setFileStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFileBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>智能体</h1>
          <p>每个智能体拥有独立 workspace、agent-core、工具权限与能力包配置。</p>
        </div>
        <button type="button" className="btn-primary" onClick={props.onCreate}>
          新建智能体
        </button>
      </header>

      <div className="agents-shell">
        <SectionCard className="agents-list">
          {props.agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="agent-list-item"
              data-active={agent.id === active?.id ? "true" : undefined}
              onClick={() => setActiveId(agent.id)}
              aria-pressed={agent.id === active?.id}
            >
              <span className="agent-list-name">{agent.name}</span>
              <span className="agent-list-model">{agent.model}</span>
            </button>
          ))}
        </SectionCard>

        {active ? (
          <SectionCard className="agent-config">
            <div className="agent-config-head">
              <div>
                <h2 className="agent-config-title">Agent 配置</h2>
                <div className="agent-config-id">{active.id}</div>
              </div>
              <div className="agent-config-actions">
                <button type="button" className="btn-secondary" onClick={() => props.onOpenChat(active.id)}>
                  打开对话
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={saving || !draft.name.trim() || !draft.instructions.trim()}
                  onClick={save}
                >
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>

            <div className="agent-config-grid">
              <Field label="名称">
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="模型">
                <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
              </Field>
              <Field label="推理强度">
                <select
                  value={draft.reasoning}
                  onChange={(e) => setDraft({ ...draft, reasoning: e.target.value as ReasoningLevel })}
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </Field>
              <Field label="Skills" hint="留空=全部可用，逗号分隔；输入 none 禁用">
                <input
                  aria-label="Skills"
                  value={draft.skillsText}
                  onChange={(e) => setDraft({ ...draft, skillsText: e.target.value })}
                />
              </Field>
            </div>

            <Field label="描述">
              <textarea
                rows={3}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Field>

            <InfoBlock title="Workspace" value={active.workspace.path} />

            <section className="agent-tools">
              <div className="agent-tools-head">
                <Field label="Tools 预设">
                  <select
                    value={draft.toolPreset}
                    onChange={(event) => setDraft({ ...draft, ...toolPolicyFromPreset(event.target.value as AgentToolPreset) })}
                  >
                    <option value="minimal">minimal</option>
                    <option value="standard">standard</option>
                    <option value="developer">developer</option>
                    <option value="tl">tl</option>
                    <option value="full">full</option>
                    <option value="none">none</option>
                  </select>
                </Field>
                <div className="agent-tools-presets">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setDraft({ ...draft, ...toolPolicyFromPreset("full") })}
                  >
                    全选
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setDraft({ ...draft, ...toolPolicyFromPreset("none") })}>
                    清空
                  </button>
                </div>
              </div>
              <ToolGroupSelector
                groups={props.toolGroups}
                selected={draft.tools}
                onChange={(tools) => setDraft({ ...draft, ...toolPolicyFromSelection(draft.toolPreset, tools) })}
              />
            </section>

            <Field label="Instructions">
              <textarea
                rows={8}
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              />
            </Field>

            <section className="agent-core">
              <div className="agent-core-head">
                <div>
                  <h3 className="agent-core-title">Agent Core</h3>
                  <div className="agent-core-path">{corePath || "未加载"}</div>
                </div>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!selectedFile || fileBusy}
                  onClick={saveCoreFile}
                >
                  {fileBusy ? "处理中..." : "保存文件"}
                </button>
              </div>

              <div className="agent-core-body">
                <div className="agent-core-files">
                  {coreFiles.map((file) => (
                    <button
                      key={file.name}
                      type="button"
                      className="agent-core-file"
                      data-active={file.name === selectedFile ? "true" : undefined}
                      onClick={() => setSelectedFile(file.name)}
                      aria-pressed={file.name === selectedFile}
                    >
                      {file.name}
                    </button>
                  ))}
                </div>
                <textarea
                  aria-label="Agent Core 文件内容"
                  className="agent-core-editor"
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                  rows={14}
                  disabled={!selectedFile || fileBusy}
                />
              </div>
              {fileStatus ? <div className="agent-core-status">{fileStatus}</div> : null}
            </section>
          </SectionCard>
        ) : (
          <SectionCard className="agent-empty">
            还没有智能体。
          </SectionCard>
        )}
      </div>
    </div>
  );
}

function draftFromAgent(agent: Agent | undefined): Draft {
  return {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    model: agent?.model ?? "",
    reasoning: agent?.reasoning ?? "medium",
    tools: agent?.tools ?? [],
    toolPreset: agent?.toolPreset ?? "none",
    toolInclude: agent?.toolInclude ?? agent?.tools ?? [],
    toolExclude: agent?.toolExclude ?? [],
    skillsText: agent?.skills === undefined ? "" : agent.skills.length === 0 ? "none" : agent.skills.join(", "),
    instructions: agent?.instructions ?? "",
  };
}

function parseSkills(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function InfoBlock(props: { title: string; value: string }) {
  return (
    <div className="agent-info-block">
      <div className="agent-info-label">{props.title}</div>
      <div className="agent-info-value">
        {props.value}
      </div>
    </div>
  );
}
