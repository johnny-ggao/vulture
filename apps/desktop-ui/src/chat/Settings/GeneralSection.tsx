import { useState } from "react";
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "../../app/theme";
import { SettingsSection } from "./SettingsSection";
import type { SettingsPageProps } from "./types";

/* ============================================================
 * GeneralSection (C2)
 *
 * Compact shell for the personal-workbench surfaces: appearance / language /
 * hotkeys / startup.
 *
 * Surfaces marked "unwired" are intentionally non-functional — they show
 * the user where each knob will live without pretending to do anything.
 * ============================================================ */
export function GeneralSection(props: SettingsPageProps) {
  void props;
  const [theme, setTheme] = useState<ThemePreference>(() => getThemePreference());

  function updateTheme(next: ThemePreference) {
    setTheme(next);
    setThemePreference(next);
  }

  return (
    <SettingsSection
      title="通用"
      description="外观、语言、快捷键与启动。"
    >
      <SectionGroup title="外观与语言">
        <FormRow label="外观">
          <ThemeSegmented value={theme} onChange={updateTheme} />
        </FormRow>
        <FormRow label="语言">
          <DisabledSelect value="zh">
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </DisabledSelect>
        </FormRow>
        <FormRow label="发送快捷键" hint="对话输入框的回车行为。">
          <DisabledSegmented value="enter" options={[
            { v: "enter", l: "Enter 发送" },
            { v: "cmd-enter", l: "⌘ + Enter" },
          ]} />
        </FormRow>
      </SectionGroup>

      <SectionGroup title="启动与唤起">
        <FormRow label="开机自启" hint="登录后在后台运行。"><DisabledToggle on /></FormRow>
        <FormRow label="启动时打开主窗口" hint="关闭则只显示菜单栏图标。"><DisabledToggle /></FormRow>
        <FormRow label="全局快捷键" hint="任意应用下唤起对话窗。">
          <span className="kbd-group">
            <kbd className="kbd">⌥</kbd>
            <kbd className="kbd">⌘</kbd>
            <kbd className="kbd">Space</kbd>
            <button type="button" className="btn-secondary btn-sm" disabled>更改</button>
          </span>
        </FormRow>
        <FormRow label="菜单栏图标"><DisabledToggle on /></FormRow>
      </SectionGroup>
    </SettingsSection>
  );
}

function ThemeSegmented({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}) {
  const options: ReadonlyArray<{ value: ThemePreference; label: string }> = [
    { value: "system", label: "系统" },
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
  ];
  return (
    <div className="segmented appearance-segmented" role="radiogroup" aria-label="外观">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={"segmented-segment" + (value === option.value ? " active" : "")}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ----- Local primitives shared by C2 settings shells ----- */

export function SectionGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="section-group">
      <header className="section-group-head">
        <h3>{title}</h3>
        {hint ? <span className="section-group-hint">{hint}</span> : null}
      </header>
      <div className="section-group-body">{children}</div>
    </section>
  );
}

export function FormRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-row">
      <div className="form-row-label">
        <span>{label}</span>
        {hint ? <span className="form-row-hint">{hint}</span> : null}
      </div>
      <div className="form-row-control">{children}</div>
    </div>
  );
}

export function DisabledToggle({ on }: { on?: boolean }) {
  return (
    <span
      className={"toggle-shell" + (on ? " on" : "")}
      role="img"
      aria-label={on ? "开（未启用）" : "关（未启用）"}
      aria-disabled="true"
      title="尚未接入"
    >
      <span className="toggle-shell-knob" />
    </span>
  );
}

export function DisabledSegmented<V extends string>({
  value,
  options,
}: {
  value: V;
  options: ReadonlyArray<{ v: V; l: string }>;
}) {
  return (
    <div className="segmented-shell" role="group" aria-disabled="true" title="尚未接入">
      {options.map((o) => (
        <span
          key={o.v}
          className={"segmented-shell-btn" + (o.v === value ? " active" : "")}
        >
          {o.l}
        </span>
      ))}
    </div>
  );
}

export function DisabledSelect({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  return (
    <select
      className="provider-select"
      value={value}
      disabled
      aria-disabled="true"
      title="尚未接入"
      onChange={() => undefined}
    >
      {children}
    </select>
  );
}
