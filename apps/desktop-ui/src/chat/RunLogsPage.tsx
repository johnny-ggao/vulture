import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Agent } from "../api/agents";
import type {
  RunLogStatusFilter,
  RunLogSummaryDto,
  RunLogsListResponse,
  RunTraceEventDto,
  RunTraceResponse,
} from "../api/runLogs";
import { ErrorAlert } from "./components";

export interface RunLogsPageProps {
  agents: ReadonlyArray<Agent>;
  onListRunLogs: (query: {
    status?: RunLogStatusFilter;
    agentId?: string;
    limit?: number;
    offset?: number;
  }) => Promise<RunLogsListResponse>;
  onLoadRunTrace: (runId: string) => Promise<RunTraceResponse>;
}

export function RunLogsPage(props: RunLogsPageProps) {
  return <RunLogsPanel {...props} />;
}

type StatusFilter = "all" | RunLogStatusFilter;

interface ListState {
  loading: boolean;
  items: RunLogSummaryDto[];
  nextOffset: number | null;
  error: string | null;
}

interface TraceState {
  runId: string | null;
  loading: boolean;
  data: RunTraceResponse | null;
  error: string | null;
}

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失败" },
  { value: "recoverable", label: "可恢复" },
  { value: "cancelled", label: "已取消" },
];

export function RunLogsPanel(props: RunLogsPageProps & { embedded?: boolean }) {
  const embedded = props.embedded === true;
  const [status, setStatus] = useState<StatusFilter>("all");
  const [agentId, setAgentId] = useState("all");
  const [list, setList] = useState<ListState>({
    loading: false,
    items: [],
    nextOffset: null,
    error: null,
  });
  const [trace, setTrace] = useState<TraceState>({
    runId: null,
    loading: false,
    data: null,
    error: null,
  });

  async function loadList(offset = 0, append = false) {
    setList((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await props.onListRunLogs({
        status: status === "all" ? undefined : status,
        agentId: agentId === "all" ? undefined : agentId,
        limit: 50,
        offset,
      });
      setList((prev) => ({
        loading: false,
        items: append ? [...prev.items, ...data.items] : data.items,
        nextOffset: data.nextOffset,
        error: null,
      }));
    } catch (cause) {
      setList((prev) => ({
        ...prev,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  }

  useEffect(() => {
    void loadList();
  }, [status, agentId]);

  async function openTrace(runId: string) {
    setTrace({ runId, loading: true, data: null, error: null });
    try {
      const data = await props.onLoadRunTrace(runId);
      setTrace({ runId, loading: false, data, error: null });
    } catch (cause) {
      setTrace({
        runId,
        loading: false,
        data: null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const selectedSummary = useMemo(
    () => list.items.find((item) => item.run.id === trace.runId) ?? null,
    [list.items, trace.runId],
  );

  const filterControls = (
    <>
      <span className="run-logs-count" aria-live="polite">
        {list.loading ? "加载中..." : `${list.items.length} 条`}
      </span>
      <label>
        <span>状态</span>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as StatusFilter)}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>智能体</span>
        <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          <option value="all">全部</option>
          {props.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );

  return (
    <div className={embedded ? "run-logs-page run-logs-embedded" : "page run-logs-page"}>
      <header className={embedded ? "run-logs-header" : "page-header run-logs-page-header"}>
        <div className={embedded ? undefined : "run-logs-page-title"}>
          {embedded ? <h2>运行日志</h2> : <h1>运行日志</h1>}
          <p>独立诊断视图，按需查看 run 的事件、工具、审批、恢复与产物记录。</p>
        </div>
        {embedded ? (
          <button type="button" className="btn-secondary" onClick={() => loadList()}>
            刷新
          </button>
        ) : (
          <div className="run-logs-toolbar" role="toolbar" aria-label="运行日志筛选与刷新">
            {filterControls}
            <button type="button" className="btn-secondary" onClick={() => loadList()}>
              刷新
            </button>
          </div>
        )}
      </header>

      {embedded ? (
        <div className="run-logs-toolbar" role="toolbar" aria-label="运行日志筛选">
          {filterControls}
        </div>
      ) : null}

      <ErrorAlert message={list.error} />

      <div className="run-logs-layout">
        <section className="run-logs-list" aria-label="运行日志列表">
          <div className="run-logs-pane-head">
            <span>Runs</span>
            <strong>{list.items.length}</strong>
          </div>
          {list.items.length === 0 && !list.loading ? (
            <div className="placeholder placeholder-tall">没有匹配的运行日志。</div>
          ) : (
            list.items.map((item) => (
              <button
                key={item.run.id}
                type="button"
                className={
                  "run-log-row" + (trace.runId === item.run.id ? " run-log-row-active" : "")
                }
                onClick={() => openTrace(item.run.id)}
              >
                <span className={`run-log-status run-log-status-${item.run.status}`}>
                  {statusLabel(item.run.status)}
                </span>
                <span className="run-log-main">
                  <strong>{item.conversationTitle || item.run.conversationId}</strong>
                  <span>
                    {item.model ?? "model n/a"} · {formatTime(item.run.startedAt)}
                  </span>
                </span>
                <span className="run-log-metrics">
                  {item.toolCallCount} tools · {item.approvalCount} approvals ·{" "}
                  {formatUsage(item.run.usage)}
                </span>
              </button>
            ))
          )}
          {list.nextOffset !== null ? (
            <button
              type="button"
              className="btn-secondary run-logs-more"
              disabled={list.loading}
              onClick={() => loadList(list.nextOffset ?? 0, true)}
            >
              加载更多
            </button>
          ) : null}
        </section>

        <section className="run-log-detail" aria-label="运行日志详情">
          <div className="run-logs-pane-head">
            <span>Trace</span>
            <strong>{trace.runId ? "已选择" : "未选择"}</strong>
          </div>
          {!trace.runId ? (
            <div className="placeholder placeholder-tall">选择一条运行日志查看详情。</div>
          ) : trace.loading ? (
            <div className="placeholder placeholder-tall">加载运行详情...</div>
          ) : trace.error ? (
            <ErrorAlert message={trace.error} />
          ) : trace.data ? (
            <RunTraceDetail summary={selectedSummary} trace={trace.data} />
          ) : null}
        </section>
      </div>
    </div>
  );
}

function RunTraceDetail({
  summary,
  trace,
}: {
  summary: RunLogSummaryDto | null;
  trace: RunTraceResponse;
}) {
  const toolEvents = trace.events.filter((event) => event.type.startsWith("tool."));
  const recoveryEvents = trace.events.filter((event) => event.type.startsWith("run.recover"));
  const timelineEvents = compactTimelineEvents(trace.events);
  return (
    <div className="run-trace-detail">
      <div className="run-trace-summary">
        <div>
          <span>状态</span>
          <strong>{statusLabel(trace.run.status)}</strong>
        </div>
        <div>
          <span>耗时</span>
          <strong>{formatDuration(trace.run.startedAt, trace.run.endedAt)}</strong>
        </div>
        <div>
          <span>Tokens</span>
          <strong>{formatUsage(trace.run.usage)}</strong>
        </div>
        <div>
          <span>事件</span>
          <strong>{summary?.eventCount ?? trace.events.length}</strong>
        </div>
      </div>

      {trace.run.error ? (
        <div className="run-trace-error">
          {trace.run.error.code}: {trace.run.error.message}
        </div>
      ) : null}

      <TraceSection title="Timeline">
        <div className="run-trace-timeline">
          {timelineEvents.map((entry) => (
            <div key={entry.key} className="run-trace-event">
              <span>{formatTime(entry.createdAt)}</span>
              <strong>{entry.label}</strong>
              <code>{entry.seqLabel}</code>
            </div>
          ))}
        </div>
      </TraceSection>

      <TraceSection title="Tool Calls">
        {toolEvents.length === 0 ? (
          <p className="run-trace-muted">没有工具调用。</p>
        ) : (
          <div className="run-trace-json-list">
            {toolEvents.map((event) => (
              <details key={`${event.runId}:${event.seq}`}>
                <summary>
                  {event.type} {typeof event.callId === "string" ? event.callId : ""}
                </summary>
                <pre>{formatJson(event)}</pre>
              </details>
            ))}
          </div>
        )}
      </TraceSection>

      <TraceSection title="Recovery">
        {recoveryEvents.length === 0 && !trace.recovery ? (
          <p className="run-trace-muted">没有恢复记录。</p>
        ) : (
          <div className="run-trace-json-list">
            {recoveryEvents.map((event) => (
              <details key={`${event.runId}:${event.seq}`}>
                <summary>{event.type}</summary>
                <pre>{formatJson(event)}</pre>
              </details>
            ))}
            {trace.recovery ? (
              <details>
                <summary>current recovery state</summary>
                <pre>{formatJson(trace.recovery)}</pre>
              </details>
            ) : null}
          </div>
        )}
      </TraceSection>

      <TraceSection title="Subagents">
        {trace.subagentSessions.length === 0 ? (
          <p className="run-trace-muted">没有子智能体会话。</p>
        ) : (
          <div className="run-trace-json-list">
            {trace.subagentSessions.map((session) => (
              <details key={session.id}>
                <summary>
                  {session.label} · {session.status}
                </summary>
                <pre>{formatJson(session)}</pre>
              </details>
            ))}
          </div>
        )}
      </TraceSection>

      <TraceSection title="Artifacts">
        {trace.artifacts.length === 0 ? (
          <p className="run-trace-muted">没有产物记录。</p>
        ) : (
          <div className="run-trace-json-list">
            {trace.artifacts.map((artifact) => (
              <details key={artifact.id}>
                <summary>
                  {artifact.kind} · {artifact.title}
                </summary>
                <pre>{formatJson(artifact)}</pre>
              </details>
            ))}
          </div>
        )}
      </TraceSection>

      <TraceSection title="Raw">
        <details className="run-trace-raw">
          <summary>完整响应 JSON</summary>
          <pre>{formatJson(trace, 12000)}</pre>
        </details>
      </TraceSection>
    </div>
  );
}

function TraceSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="run-trace-section">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

interface TimelineEntry {
  key: string;
  createdAt: string;
  label: string;
  seqLabel: string;
}

function compactTimelineEvents(events: RunTraceEventDto[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let deltaGroup: {
    startedAt: string;
    firstSeq: number;
    lastSeq: number;
    count: number;
    chars: number;
  } | null = null;

  function flushDeltaGroup() {
    if (!deltaGroup) return;
    entries.push({
      key: `text-delta:${deltaGroup.firstSeq}:${deltaGroup.lastSeq}`,
      createdAt: deltaGroup.startedAt,
      label: `text stream · ${deltaGroup.count} chunks · ${deltaGroup.chars} chars`,
      seqLabel:
        deltaGroup.firstSeq === deltaGroup.lastSeq
          ? `#${deltaGroup.firstSeq}`
          : `#${deltaGroup.firstSeq}-${deltaGroup.lastSeq}`,
    });
    deltaGroup = null;
  }

  for (const event of events) {
    if (event.type === "text.delta") {
      const text = typeof event.text === "string" ? event.text : "";
      if (!deltaGroup) {
        deltaGroup = {
          startedAt: event.createdAt,
          firstSeq: event.seq,
          lastSeq: event.seq,
          count: 1,
          chars: text.length,
        };
      } else {
        deltaGroup.lastSeq = event.seq;
        deltaGroup.count += 1;
        deltaGroup.chars += text.length;
      }
      continue;
    }

    flushDeltaGroup();
    entries.push({
      key: `${event.runId}:${event.seq}`,
      createdAt: event.createdAt,
      label: eventLabel(event),
      seqLabel: `#${event.seq}`,
    });
  }

  flushDeltaGroup();
  return entries;
}

function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "排队";
    case "running":
      return "运行中";
    case "recoverable":
      return "可恢复";
    case "succeeded":
      return "成功";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function eventLabel(event: RunTraceEventDto): string {
  if (event.type === "run.started" && typeof event.model === "string") {
    return `${event.type} · ${event.model}`;
  }
  if (event.type.startsWith("tool.") && typeof event.tool === "string") {
    return `${event.type} · ${event.tool}`;
  }
  if (event.type === "approval.review") {
    const parts = [event.type];
    if (typeof event.status === "string") parts.push(event.status);
    if (typeof event.risk === "string") parts.push(event.risk);
    if (typeof event.tool === "string") parts.push(event.tool);
    return parts.join(" · ");
  }
  return event.type;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "进行中";
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "n/a";
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatUsage(usage: RunLogSummaryDto["run"]["usage"]): string {
  if (!usage) return "tokens n/a";
  return `${usage.inputTokens} in / ${usage.outputTokens} out`;
}

function formatJson(value: unknown, maxLength = 8000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n... truncated` : text;
}
