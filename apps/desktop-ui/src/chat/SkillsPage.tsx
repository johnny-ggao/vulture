import { useEffect, useMemo, useState } from "react";
import type { Agent } from "../api/agents";
import type { SkillListItem, SkillListResponse } from "../api/skills";
import { Badge, ErrorAlert, Field, SearchInput, Toggle, useCursorGloss } from "./components";
import { SkillDetailModal } from "./SkillDetailModal";

export interface SkillsPageProps {
  agents: ReadonlyArray<Agent>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  onLoadSkills: (agentId: string) => Promise<SkillListResponse>;
  onSaveAgentSkills: (id: string, skills: string[] | null) => Promise<void>;
}

type LoadState =
  | { status: "idle" | "loading"; data: SkillListResponse | null; error: string | null }
  | { status: "ready"; data: SkillListResponse; error: null }
  | { status: "error"; data: SkillListResponse | null; error: string };

const SOURCE_LABEL: Record<SkillListItem["source"], string> = {
  workspace: "Workspace",
  profile: "Profile",
};

export function SkillsPage(props: SkillsPageProps) {
  const [state, setState] = useState<LoadState>({ status: "idle", data: null, error: null });
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [detailSkillName, setDetailSkillName] = useState<string | null>(null);

  const activeAgent = useMemo(
    () => props.agents.find((agent) => agent.id === props.selectedAgentId) ?? props.agents[0],
    [props.agents, props.selectedAgentId],
  );

  async function load(agentId: string, cancelled: () => boolean = () => false) {
    setState((prev) => ({ status: "loading", data: prev.data, error: null }));
    try {
      const data = await props.onLoadSkills(agentId);
      if (!cancelled()) setState({ status: "ready", data, error: null });
    } catch (cause) {
      if (!cancelled()) {
        setState({
          status: "error",
          data: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  useEffect(() => {
    if (!activeAgent) return;
    let cancelled = false;
    void load(activeAgent.id, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [activeAgent?.id]);

  async function savePolicy(skills: string[] | null) {
    if (!activeAgent || saving) return;
    setSaving(true);
    try {
      await props.onSaveAgentSkills(activeAgent.id, skills);
      await load(activeAgent.id);
    } finally {
      setSaving(false);
    }
  }

  async function toggleSkill(skill: SkillListItem) {
    const data = state.data;
    if (!data) return;
    const current = new Set(
      data.policy === "all"
        ? data.items.map((item) => item.name)
        : data.allowlist ?? [],
    );
    if (current.has(skill.name)) current.delete(skill.name);
    else current.add(skill.name);
    await savePolicy([...current].sort((left, right) => left.localeCompare(right, "en")));
  }

  const data = state.data;
  // Memoise `items` so its identity is stable when `data?.items` is — the
  // `?? []` shorthand otherwise creates a fresh array reference on every
  // render where data is null, churning the auto-close effect below.
  const items = useMemo(() => data?.items ?? [], [data]);
  const filtered = useMemo(() => filterSkills(items, query), [items, query]);
  const grouped = useMemo(() => groupBySource(filtered), [filtered]);

  const detailSkill =
    detailSkillName !== null
      ? items.find((s) => s.name === detailSkillName) ?? null
      : null;

  // If the skill being viewed has been removed (e.g. profile changed), close
  // the modal rather than rendering an empty shell.
  useEffect(() => {
    if (detailSkillName !== null && !items.some((s) => s.name === detailSkillName)) {
      setDetailSkillName(null);
    }
  }, [detailSkillName, items]);

  // Round 18 / B2 — marketplace layout: source filter rail + featured
  // strip (top 3 model-invocable items) + grid of cards. Per-agent
  // toggle + policy buttons are preserved (the existing per-agent
  // workflow has no other home), but the visual idiom now reads as a
  // browseable marketplace rather than a flat allowlist editor.
  const [sourceFilter, setSourceFilter] = useState<"all" | "workspace" | "profile">("all");
  const sourceFiltered = sourceFilter === "all"
    ? filtered
    : filtered.filter((s) => s.source === sourceFilter);
  const counts = {
    all: filtered.length,
    workspace: filtered.filter((s) => s.source === "workspace").length,
    profile: filtered.filter((s) => s.source === "profile").length,
  };
  const featured = sourceFilter === "all" && !query
    ? items.filter((s) => s.modelInvocationEnabled).slice(0, 3)
    : [];

  return (
    <div className="page skills-page-marketplace">
      <header className="page-header">
        <div>
          <h1>技能</h1>
          <p>
            浏览可加载的能力包；选择一个智能体后可按需启用。
          </p>
        </div>
      </header>

      <div className="skills-toolbar-row">
        <Field label="智能体">
          <select
            value={activeAgent?.id ?? ""}
            aria-label="选择智能体"
            onChange={(event) => props.onSelectAgent(event.target.value)}
          >
            {props.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="skills-search">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="搜索 skill…"
            ariaLabel="搜索 skill"
          />
        </div>
        <div className="skills-policy">
          <button
            type="button"
            className={data?.policy === "all" ? "btn-primary" : "btn-secondary"}
            disabled={!activeAgent || saving}
            onClick={() => savePolicy(null)}
          >
            全部启用
          </button>
          <button
            type="button"
            className={data?.policy === "none" ? "btn-primary" : "btn-secondary"}
            disabled={!activeAgent || saving}
            onClick={() => savePolicy([])}
          >
            全部禁用
          </button>
        </div>
      </div>

      <div className="skills-meta">
        <span>策略：{policyLabel(data?.policy)}</span>
        <span aria-hidden="true">·</span>
        <span>{items.length} 个可加载 skill</span>
        {state.status === "loading" ? <span>· 刷新中…</span> : null}
        {saving ? <span>· 保存中…</span> : null}
      </div>

      <ErrorAlert message={state.error} />

      <div className="skills-market-body">
        <aside className="skills-cats" aria-label="技能来源">
          {(
            [
              { id: "all", label: "全部", count: counts.all },
              { id: "workspace", label: "Workspace", count: counts.workspace },
              { id: "profile", label: "Profile", count: counts.profile },
            ] as const
          ).map((c) => (
            <button
              key={c.id}
              type="button"
              className={"skills-cat" + (sourceFilter === c.id ? " active" : "")}
              onClick={() => setSourceFilter(c.id)}
            >
              <span>{c.label}</span>
              <span className="skills-cat-count">{c.count}</span>
            </button>
          ))}
        </aside>

        <div className="skills-market-main">
          {featured.length > 0 ? (
            <section className="skills-feature-block" aria-label="精选">
              <div className="skills-section-h">
                <span>精选</span>
                <span className="skills-section-h-sub">模型可见的高频技能</span>
              </div>
              <div className="skills-feature-row">
                {featured.map((skill) => (
                  <button
                    key={skill.name}
                    type="button"
                    className="skills-feature-card"
                    onClick={() => setDetailSkillName(skill.name)}
                  >
                    <div className="skills-feature-name">
                      {skill.name}
                      <Badge tone="info">模型可见</Badge>
                    </div>
                    <div className="skills-feature-tagline">
                      {skill.description || "（无描述）"}
                    </div>
                    <div className="skills-feature-foot">
                      <span className="skills-feature-source">
                        {SOURCE_LABEL[skill.source]}
                      </span>
                      <span className="skills-feature-spacer" />
                      <span
                        className={"skills-feature-state" + (skill.enabled ? " on" : "")}
                      >
                        {skill.enabled ? "已启用" : "未启用"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <div className="skills-section-h skills-section-h-grid">
            <span>
              {sourceFilter === "all"
                ? "全部技能"
                : SOURCE_LABEL[sourceFilter as keyof typeof SOURCE_LABEL]}
            </span>
            <span className="skills-section-h-sub">
              {sourceFiltered.length === 0 ? "没有匹配的技能" : `${sourceFiltered.length} 项`}
            </span>
          </div>

          {sourceFiltered.length === 0 && state.status !== "loading" ? (
            <div className="placeholder placeholder-tall">
              <span>
                {items.length === 0
                  ? "当前智能体没有可加载的 skill。"
                  : `没有找到匹配 "${query}" 的 skill。`}
              </span>
            </div>
          ) : (
            <div className="skills-grid">
              {sourceFiltered.map((skill) => (
                <SkillCard
                  key={skill.name}
                  skill={skill}
                  saving={saving}
                  onOpenDetail={() => setDetailSkillName(skill.name)}
                  onToggle={() => void toggleSkill(skill)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <SkillDetailModal
        open={detailSkill !== null}
        skill={detailSkill}
        saving={saving}
        onClose={() => setDetailSkillName(null)}
        onToggle={(s) => {
          void toggleSkill(s);
        }}
      />
    </div>
  );
}

interface SkillCardProps {
  skill: SkillListItem;
  saving: boolean;
  onOpenDetail: () => void;
  onToggle: () => void;
}

/**
 * Compact card for a single skill. Click anywhere except the inline Toggle
 * to open the detail modal; the Toggle stays interactive in-place so quick
 * enable/disable doesn't require a round-trip through the modal.
 */
function SkillCard({ skill, saving, onOpenDetail, onToggle }: SkillCardProps) {
  // Shared cursor-gloss handlers; see useCursorGloss for caching details.
  const { ref, ...gloss } = useCursorGloss<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className="skill-card"
      data-enabled={skill.enabled ? "true" : "false"}
      {...gloss}
    >
      <button
        type="button"
        className="skill-card-surface"
        aria-label={`${skill.name}: ${skill.description || "查看详情"}`}
        onClick={onOpenDetail}
      >
        <div className="skill-card-header">
          <strong className="skill-card-name">{skill.name}</strong>
          <span className="skill-card-badges">
            <Badge tone={skill.modelInvocationEnabled ? "info" : "neutral"}>
              {skill.modelInvocationEnabled ? "模型可见" : "仅手动"}
            </Badge>
          </span>
        </div>
        <p className="skill-card-desc">
          {skill.description || "（无描述）"}
        </p>
        <code className="skill-card-path">{skill.filePath}</code>
      </button>
      <div className="skill-card-toggle">
        <Toggle
          ariaLabel={`${skill.enabled ? "禁用" : "启用"} ${skill.name}`}
          checked={skill.enabled}
          disabled={saving}
          onChange={onToggle}
        />
      </div>
    </div>
  );
}

function filterSkills(items: ReadonlyArray<SkillListItem>, query: string): SkillListItem[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...items];
  return items.filter((item) =>
    item.name.toLowerCase().includes(trimmed) ||
    (item.description ?? "").toLowerCase().includes(trimmed),
  );
}

function groupBySource(items: ReadonlyArray<SkillListItem>) {
  const order: SkillListItem["source"][] = ["workspace", "profile"];
  return order
    .map((source) => ({
      source,
      items: items.filter((item) => item.source === source),
    }))
    .filter((group) => group.items.length > 0);
}

function policyLabel(policy: SkillListResponse["policy"] | undefined): string {
  if (policy === "all") return "全部启用";
  if (policy === "none") return "全部禁用";
  if (policy === "allowlist") return "仅启用所选";
  return "加载中";
}
