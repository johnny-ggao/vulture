import { useEffect, useMemo, useState } from "react";
import type {
  WebSearchProviderId,
  WebSearchSettingsResponse,
  WebSearchTestResult,
} from "../../api/webSearchSettings";
import { ErrorAlert } from "../components";
import { FormRow, SectionGroup } from "./GeneralSection";
import { SettingsSection } from "./SettingsSection";
import type { SettingsPageProps } from "./types";

const TEST_QUERY = "OpenAI Agents SDK";

export function WebSearchSection(props: SettingsPageProps) {
  const [settings, setSettings] = useState<WebSearchSettingsResponse | null>(null);
  const [provider, setProvider] = useState<WebSearchProviderId>("multi");
  const [searxngBaseUrl, setSearxngBaseUrl] = useState("");
  const [braveApiKey, setBraveApiKey] = useState("");
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [perplexityApiKey, setPerplexityApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
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
      setBraveApiKey(loaded.settings.braveApiKey ?? "");
      setTavilyApiKey(loaded.settings.tavilyApiKey ?? "");
      setPerplexityApiKey(loaded.settings.perplexityApiKey ?? "");
      setGeminiApiKey(loaded.settings.geminiApiKey ?? "");
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
    braveApiKey: provider === "brave-api" ? braveApiKey.trim() : null,
    tavilyApiKey: provider === "tavily-api" ? tavilyApiKey.trim() : null,
    perplexityApiKey: provider === "perplexity-api" ? perplexityApiKey.trim() : null,
    geminiApiKey: provider === "gemini-search" ? geminiApiKey.trim() : null,
  }), [provider, searxngBaseUrl, braveApiKey, tavilyApiKey, perplexityApiKey, geminiApiKey]);

  const currentDescriptor = useMemo(
    () => settings?.providers.find((descriptor) => descriptor.id === provider) ?? null,
    [settings, provider],
  );

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
      setBraveApiKey(updated.settings.braveApiKey ?? "");
      setTavilyApiKey(updated.settings.tavilyApiKey ?? "");
      setPerplexityApiKey(updated.settings.perplexityApiKey ?? "");
      setGeminiApiKey(updated.settings.geminiApiKey ?? "");
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
      {busy === "load" && settings === null ? (
        <div className="websearch-skeleton" aria-busy="true" aria-label="加载中">
          <div className="websearch-skeleton-row">
            <div className="websearch-skeleton-label" />
            <div className="websearch-skeleton-input" />
          </div>
          <div className="websearch-skeleton-row">
            <div className="websearch-skeleton-label" />
            <div className="websearch-skeleton-input" />
          </div>
        </div>
      ) : (
      <SectionGroup title="搜索源">
        <FormRow label="搜索源">
          <select
            className="provider-select"
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
              { id: "multi", label: "Auto (DDG → Bing → Brave)" },
              { id: "duckduckgo-html", label: "DuckDuckGo HTML" },
              { id: "searxng", label: "SearXNG" },
            ]).map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </FormRow>
        {currentDescriptor?.description ? (
          <p className="settings-hint">{currentDescriptor.description}</p>
        ) : null}
        {provider === "searxng" ? (
          <FormRow label="SearXNG URL" hint="自托管或公共 SearXNG 实例的根地址。">
            <input
              className="provider-text-input"
              aria-label="SearXNG URL"
              value={searxngBaseUrl}
              disabled={busy === "load"}
              placeholder="https://search.example.com"
              onChange={(event) => {
                setSearxngBaseUrl(event.target.value);
                setSaved(false);
                setTestResult(null);
              }}
            />
          </FormRow>
        ) : null}
        {provider === "brave-api" ? (
          <FormRow label="Brave API Key" hint="可在 search.brave.com/api 申请。2000 queries/月免费。">
            <input
              className="provider-text-input"
              type="password"
              aria-label="Brave API Key"
              value={braveApiKey}
              disabled={busy === "load"}
              placeholder="brave-api-key"
              onChange={(event) => {
                setBraveApiKey(event.target.value);
                setSaved(false);
                setTestResult(null);
              }}
            />
          </FormRow>
        ) : null}
        {provider === "tavily-api" ? (
          <FormRow label="Tavily API Key" hint="可在 app.tavily.com 申请，注册门槛低于 Brave。1000 queries/月免费。">
            <input
              className="provider-text-input"
              type="password"
              aria-label="Tavily API Key"
              value={tavilyApiKey}
              disabled={busy === "load"}
              placeholder="tvly-xxxxxxxxxxxxxxxx"
              onChange={(event) => {
                setTavilyApiKey(event.target.value);
                setSaved(false);
                setTestResult(null);
              }}
            />
          </FormRow>
        ) : null}
        {provider === "perplexity-api" ? (
          <FormRow label="Perplexity API Key" hint="可在 perplexity.ai/settings/api 申请。返回带引用的 AI 合成答案。">
            <input
              className="provider-text-input"
              type="password"
              aria-label="Perplexity API Key"
              value={perplexityApiKey}
              disabled={busy === "load"}
              placeholder="pplx-xxxxxxxxxxxxxxxx"
              onChange={(event) => {
                setPerplexityApiKey(event.target.value);
                setSaved(false);
                setTestResult(null);
              }}
            />
          </FormRow>
        ) : null}
        {provider === "gemini-search" ? (
          <FormRow
            label="Gemini API Key"
            hint="留空则自动复用「模型」里配置的 Gemini API Key（推荐）。可在 aistudio.google.com 免费申请。"
          >
            <input
              className="provider-text-input"
              type="password"
              aria-label="Gemini API Key"
              value={geminiApiKey}
              disabled={busy === "load"}
              placeholder="留空 = 复用「模型」里的 Gemini Key"
              onChange={(event) => {
                setGeminiApiKey(event.target.value);
                setSaved(false);
                setTestResult(null);
              }}
            />
          </FormRow>
        ) : null}
        <div className="settings-inline-actions">
          <button type="button" className="btn-secondary" disabled={busy !== null} onClick={testSearch}>
            {busy === "test" ? "测试中…" : "测试"}
          </button>
          <button type="button" className="btn-primary" disabled={busy !== null} onClick={save}>
            {busy === "save" ? "保存中…" : "保存"}
          </button>
          {saved ? (
            <span className="settings-feedback settings-feedback-success" role="status">
              已保存
            </span>
          ) : null}
          {testResult ? (
            <span
              className={
                "settings-feedback" +
                (testResult.ok ? " settings-feedback-success" : " settings-feedback-error")
              }
              role="status"
            >
              {testResult.ok
                ? `${testResult.provider} · ${testResult.resultCount} 个结果`
                : testResult.error ?? "测试失败"}
            </span>
          ) : null}
        </div>
      </SectionGroup>
      )}
    </SettingsSection>
  );
}
