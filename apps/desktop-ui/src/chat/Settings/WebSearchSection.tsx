import { useEffect, useMemo, useState } from "react";
import type {
  WebSearchProviderId,
  WebSearchSettingsResponse,
  WebSearchTestResult,
} from "../../api/webSearchSettings";
import { ErrorAlert, Field } from "../components";
import { SettingsSection } from "./SettingsSection";
import type { SettingsPageProps } from "./types";

const TEST_QUERY = "OpenAI Agents SDK";

export function WebSearchSection(props: SettingsPageProps) {
  const [settings, setSettings] = useState<WebSearchSettingsResponse | null>(null);
  const [provider, setProvider] = useState<WebSearchProviderId>("duckduckgo-html");
  const [searxngBaseUrl, setSearxngBaseUrl] = useState("");
  const [busy, setBusy] = useState<"load" | "save" | "test" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<WebSearchTestResult | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    setBusy("load");
    setError(null);
    try {
      const loaded = await props.onGetWebSearchSettings();
      setSettings(loaded);
      setProvider(loaded.settings.provider);
      setSearxngBaseUrl(loaded.settings.searxngBaseUrl ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const payload = useMemo(() => ({
    provider,
    searxngBaseUrl: provider === "searxng" ? searxngBaseUrl.trim() : null,
  }), [provider, searxngBaseUrl]);

  async function testSearch() {
    if (busy) return;
    setBusy("test");
    setSaved(false);
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await props.onTestWebSearchSettings({ ...payload, query: TEST_QUERY }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (busy) return;
    setBusy("save");
    setSaved(false);
    setError(null);
    try {
      const updated = await props.onUpdateWebSearchSettings(payload);
      setSettings(updated);
      setProvider(updated.settings.provider);
      setSearxngBaseUrl(updated.settings.searxngBaseUrl ?? "");
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection
      title="联网"
      description="配置 agent 自有 web_search 工具使用的搜索源。"
      action={
        <button type="button" className="btn-secondary" disabled={busy !== null} onClick={load}>
          {busy === "load" ? "刷新中…" : "刷新"}
        </button>
      }
    >
      <ErrorAlert message={error} />
      <div className="mcp-create-grid">
        <Field label="搜索源">
          <select
            aria-label="搜索源"
            value={provider}
            disabled={busy === "load"}
            onChange={(event) => {
              setProvider(event.target.value as WebSearchProviderId);
              setSaved(false);
              setTestResult(null);
            }}
          >
            {(settings?.providers ?? [
              { id: "duckduckgo-html", label: "DuckDuckGo HTML" },
              { id: "searxng", label: "SearXNG" },
            ]).map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="SearXNG URL" hint="例如 https://search.example.com">
          <input
            aria-label="SearXNG URL"
            value={searxngBaseUrl}
            disabled={provider !== "searxng" || busy === "load"}
            placeholder="https://search.example.com"
            onChange={(event) => {
              setSearxngBaseUrl(event.target.value);
              setSaved(false);
              setTestResult(null);
            }}
          />
        </Field>
      </div>
      <div className="mcp-create-actions">
        <button type="button" className="btn-secondary" disabled={busy !== null} onClick={testSearch}>
          {busy === "test" ? "测试中..." : "测试搜索"}
        </button>
        <button type="button" className="btn-primary" disabled={busy !== null} onClick={save}>
          {busy === "save" ? "保存中..." : "保存"}
        </button>
        {saved ? (
          <span className="settings-feedback settings-feedback-success" role="status">
            已保存
          </span>
        ) : null}
      </div>
      {testResult ? (
        <div className="settings-feedback" role="status">
          {testResult.ok
            ? `${testResult.provider} · ${testResult.resultCount} 个结果`
            : testResult.error ?? "测试失败"}
        </div>
      ) : null}
    </SettingsSection>
  );
}
