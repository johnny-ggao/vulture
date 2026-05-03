import { useEffect, useMemo, useState } from "react";
import type { SkillCatalogEntry, SkillCatalogResponse, SkillListItem, SkillListResponse } from "../api/skills";
import { Badge, ErrorAlert, SearchInput, useCursorGloss } from "./components";
import { SkillDetailModal } from "./SkillDetailModal";

export interface SkillsPageProps {
  onLoadSkills: () => Promise<SkillListResponse>;
  onLoadSkillCatalog: () => Promise<SkillCatalogResponse>;
  onImportSkillPackage: (packagePath: string) => Promise<SkillCatalogEntry>;
  onInstallSkill: (name: string) => Promise<SkillCatalogEntry>;
  onUpdateSkillCatalog: () => Promise<SkillCatalogResponse>;
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
  const [catalog, setCatalog] = useState<{
    loading: boolean;
    items: SkillCatalogEntry[];
    error: string | null;
  }>({ loading: false, items: [], error: null });
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null);
  const [importPath, setImportPath] = useState("");
  const [query, setQuery] = useState("");
  const [detailSkillName, setDetailSkillName] = useState<string | null>(null);

  async function load(cancelled: () => boolean = () => false) {
    setState((prev) => ({ status: "loading", data: prev.data, error: null }));
    try {
      const data = await props.onLoadSkills();
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

  async function loadCatalog(cancelled: () => boolean = () => false) {
    setCatalog((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await props.onLoadSkillCatalog();
      if (!cancelled()) setCatalog({ loading: false, items: data.items, error: null });
    } catch (cause) {
      if (!cancelled()) {
        setCatalog((prev) => ({
          ...prev,
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadCatalog(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  async function installCatalogSkill(skill: SkillCatalogEntry) {
    if (catalogBusy) return;
    setCatalogBusy(skill.name);
    setCatalog((prev) => ({ ...prev, error: null }));
    try {
      const updated = await props.onInstallSkill(skill.name);
      setCatalog((prev) => ({
        loading: false,
        error: null,
        items: replaceCatalogEntry(prev.items, updated),
      }));
      await load();
    } catch (cause) {
      await loadCatalog();
      setCatalog((prev) => ({
        ...prev,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      setCatalogBusy(null);
    }
  }

  async function importCatalogSkill() {
    const packagePath = importPath.trim();
    if (catalogBusy || !packagePath) return;
    setCatalogBusy("__import__");
    setCatalog((prev) => ({ ...prev, error: null }));
    try {
      const imported = await props.onImportSkillPackage(packagePath);
      setCatalog((prev) => ({
        loading: false,
        error: null,
        items: replaceCatalogEntry(prev.items, imported),
      }));
      setImportPath("");
    } catch (cause) {
      setCatalog((prev) => ({
        ...prev,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      setCatalogBusy(null);
    }
  }

  async function updateCatalog() {
    if (catalogBusy) return;
    setCatalogBusy("__update_all__");
    setCatalog((prev) => ({ ...prev, error: null }));
    try {
      const data = await props.onUpdateSkillCatalog();
      setCatalog({ loading: false, items: data.items, error: null });
      await load();
    } catch (cause) {
      setCatalog((prev) => ({
        ...prev,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      setCatalogBusy(null);
    }
  }

  const data = state.data;
  // Memoise `items` so its identity is stable when `data?.items` is — the
  // `?? []` shorthand otherwise creates a fresh array reference on every
  // render where data is null, churning the auto-close effect below.
  const items = useMemo(() => data?.items ?? [], [data]);
  const filtered = useMemo(() => filterSkills(items, query), [items, query]);

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

  // Marketplace layout: featured strip + grid of cards. The page is
  // browse/install oriented; per-agent skill allowlists belong in the
  // agent editor.
  const sourceFiltered = filtered;
  const featured = !query
    ? items.filter((s) => s.modelInvocationEnabled).slice(0, 3)
    : [];

  return (
    <div className="page skills-page-marketplace">
      {/* Title row with the agent picker + search inline so the toolbar
          reads as one focused control bar. Policy switches stay small
          on the right — they're bulk actions, not primary CTAs. */}
      <header className="skills-header skills-page-header">
        <div className="skills-header-titles skills-page-title">
          <h1>技能</h1>
          <p className="skills-header-sub">
            浏览全局已安装的能力包；安装到个人目录后所有智能体均可启用，启用策略在智能体编辑页管理。
            {state.status === "loading" ? (
              <span className="skills-header-status"> · 刷新中…</span>
            ) : null}
          </p>
        </div>
        <div className="skills-header-controls">
          <div className="skills-search">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="搜索…"
              ariaLabel="搜索 skill"
              shortcut
            />
          </div>
        </div>
      </header>

      <ErrorAlert message={state.error} />
      <ErrorAlert message={catalog.error} />

      <div className="skills-market-body">
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
                        className={"skills-feature-state" + (skill.modelInvocationEnabled ? " on" : "")}
                      >
                        {skill.modelInvocationEnabled ? "模型可见" : "仅手动"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <div className="skills-section-h skills-section-h-grid">
            <span>全部技能</span>
            <span className="skills-section-h-sub">
              {sourceFiltered.length === 0 ? "没有匹配的技能" : `${sourceFiltered.length} 项`}
            </span>
          </div>

          {state.status === "loading" && items.length === 0 ? (
            // First-load shimmer — replaces the empty axis frame so the
            // user gets immediate visual feedback that data is on its
            // way (per HIG progressive-loading guidance).
            <div className="skills-skeleton-grid" aria-hidden="true">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skills-skeleton-card" />
              ))}
            </div>
          ) : sourceFiltered.length === 0 && state.status !== "loading" ? (
            <div className="placeholder placeholder-tall">
              <span>
                {items.length === 0
                  ? "还没有已安装的 skill。从下方目录安装一个开始。"
                  : `没有找到匹配 "${query}" 的 skill。`}
              </span>
            </div>
          ) : (
            <div className="skills-grid">
              {sourceFiltered.map((skill) => (
                <SkillCard
                  key={skill.name}
                  skill={skill}
                  onOpenDetail={() => setDetailSkillName(skill.name)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <section className="skill-catalog-panel" aria-label="Skill Catalog">
        <div className="skill-catalog-head">
          <div className="skill-catalog-titles">
            <h2>Skill Catalog</h2>
            <span className="skill-catalog-sub">
              {catalog.loading ? "刷新中…" : `${catalog.items.length} 个安装包`}
            </span>
          </div>
          <div className="skill-catalog-actions">
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={catalogBusy !== null}
              onClick={() => void loadCatalog()}
            >
              刷新
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={catalogBusy !== null || catalog.items.length === 0}
              onClick={() => void updateCatalog()}
            >
              {catalogBusy === "__update_all__" ? "更新中…" : "更新全部"}
            </button>
          </div>
        </div>
        <div className="skill-catalog-import">
          <label
            htmlFor="skill-catalog-import-input"
            className="visually-hidden"
          >
            Skill package path
          </label>
          <input
            id="skill-catalog-import-input"
            value={importPath}
            onChange={(event) => setImportPath(event.currentTarget.value)}
            placeholder="本地 skill package 路径，例如 /skills/csv-insights"
            disabled={catalogBusy !== null}
            aria-label="Skill package path"
            spellCheck="false"
          />
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={catalogBusy !== null || !importPath.trim()}
            onClick={() => void importCatalogSkill()}
          >
            {catalogBusy === "__import__" ? "导入中…" : "导入"}
          </button>
        </div>
        {catalog.items.length === 0 && !catalog.loading ? (
          <div className="skill-catalog-empty">还没有导入 catalog 包。</div>
        ) : (
          <div className="skill-catalog-grid">
            {catalog.items.map((skill) => (
              <SkillCatalogCard
                key={skill.name}
                skill={skill}
                busy={catalogBusy === skill.name}
                disabled={catalogBusy !== null}
                onInstall={() => void installCatalogSkill(skill)}
              />
            ))}
          </div>
        )}
      </section>

      <SkillDetailModal
        open={detailSkill !== null}
        skill={detailSkill}
        onClose={() => setDetailSkillName(null)}
      />
    </div>
  );
}

function SkillCatalogCard({
  skill,
  busy,
  disabled,
  onInstall,
}: {
  skill: SkillCatalogEntry;
  busy: boolean;
  disabled: boolean;
  onInstall: () => void;
}) {
  const actionLabel = skill.lifecycleStatus === "outdated"
    ? `更新 ${skill.name}`
    : skill.installed
      ? `重新安装 ${skill.name}`
      : `安装 ${skill.name}`;
  return (
    <article className="skill-catalog-card" data-status={skill.lifecycleStatus}>
      <div className="skill-catalog-card-head">
        <strong>{skill.name}</strong>
        <Badge tone={catalogTone(skill.lifecycleStatus)}>
          {catalogStatusLabel(skill.lifecycleStatus)}
        </Badge>
      </div>
      <p>{skill.description}</p>
      <div className="skill-catalog-version">
        {skill.installedVersion && skill.installedVersion !== skill.version
          ? `${skill.installedVersion} → ${skill.version}`
          : `v${skill.version}`}
      </div>
      {skill.lastError ? (
        <div className="skill-catalog-error" role="alert">{skill.lastError}</div>
      ) : null}
      <button
        type="button"
        className={skill.needsUpdate || !skill.installed ? "btn-primary" : "btn-secondary"}
        disabled={disabled}
        aria-label={actionLabel}
        onClick={onInstall}
      >
        {busy
          ? skill.lifecycleStatus === "outdated"
            ? "更新中…"
            : skill.installed
              ? "重装中…"
              : "安装中…"
          : skill.lifecycleStatus === "outdated"
            ? "更新"
            : skill.installed
              ? "重装"
              : "安装"}
      </button>
    </article>
  );
}

interface SkillCardProps {
  skill: SkillListItem;
  onOpenDetail: () => void;
}

/**
 * Compact browse card for a single skill. Agent-specific enablement is
 * intentionally not editable here; that policy belongs in the agent editor.
 */
function SkillCard({ skill, onOpenDetail }: SkillCardProps) {
  // Shared cursor-gloss handlers; see useCursorGloss for caching details.
  const { ref, ...gloss } = useCursorGloss<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className="skill-card"
      {...gloss}
    >
      <button
        type="button"
        className="skill-card-surface"
        aria-label={`${skill.name}: ${skill.description || "查看详情"}`}
        onClick={onOpenDetail}
      >
        <div className="skill-card-header">
          <span
            className={
              "skill-card-dot" +
              (skill.modelInvocationEnabled ? " is-model-visible" : "")
            }
            aria-hidden="true"
            title={skill.modelInvocationEnabled ? "模型可见" : "仅手动"}
          />
          <strong className="skill-card-name">{skill.name}</strong>
        </div>
        <p className="skill-card-desc">
          {skill.description || "（无描述）"}
        </p>
      </button>
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

function catalogStatusLabel(status: SkillCatalogEntry["lifecycleStatus"]): string {
  switch (status) {
    case "installed": return "已安装";
    case "outdated": return "可更新";
    case "failed": return "失败";
    case "not_installed": return "未安装";
  }
}

function catalogTone(status: SkillCatalogEntry["lifecycleStatus"]): "success" | "info" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "installed": return "success";
    case "outdated": return "warning";
    case "failed": return "danger";
    case "not_installed": return "neutral";
  }
}

function replaceCatalogEntry(
  items: SkillCatalogEntry[],
  next: SkillCatalogEntry,
): SkillCatalogEntry[] {
  const index = items.findIndex((item) => item.name === next.name);
  if (index < 0) return [...items, next].sort((left, right) => left.name.localeCompare(right.name, "en"));
  return items.map((item) => (item.name === next.name ? next : item));
}
