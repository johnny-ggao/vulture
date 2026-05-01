import {
  DisabledSelect,
  DisabledToggle,
  FormRow,
  SectionGroup,
} from "./GeneralSection";
import { SettingsSection } from "./SettingsSection";

/* ============================================================
 * ChannelsSection (C2)
 *
 * UI shell for the routing-rules surface described in the kit.
 * Channels connect external inboxes (Gmail, 飞书, Telegram, SMS,
 * Webhook) to agents via numbered routing rules. Backend wiring
 * is not yet in place — every control here is a non-functional
 * placeholder so users can see where the affordance will land.
 *
 * Round 6 / "card layout" rework: the connected-channels list is
 * now a tile grid (auto-fit minmax 260px) so each channel reads
 * as a distinct surface with its own tint glyph, account info,
 * and traffic stats. Routing rules stay as a numbered list since
 * order matters there — they're a sequence, not a roster.
 * ============================================================ */

interface ChannelSpec {
  id: string;
  kind: "gmail" | "feishu" | "telegram" | "sms" | "webhook";
  name: string;
  glyph: string;
  /** Subtle background tint for the glyph mark. */
  tint: string;
  /** Glyph foreground that meets 4.5:1 against tint. */
  fg: string;
  account: string;
  hint: string;
  inbound: number;
  outbound: number;
  status: "on" | "off";
}

const CHANNELS: ReadonlyArray<ChannelSpec> = [
  {
    id: "gmail",
    kind: "gmail",
    name: "Gmail",
    glyph: "✉",
    tint: "rgba(212, 76, 64, 0.10)",
    fg: "#b13d2f",
    account: "me@example.com",
    hint: "IMAP + 应用专用密码",
    inbound: 124,
    outbound: 38,
    status: "on",
  },
  {
    id: "feishu",
    kind: "feishu",
    name: "飞书",
    glyph: "飞",
    tint: "rgba(51, 112, 255, 0.10)",
    fg: "#2553b8",
    account: "王同学（个人）",
    hint: "机器人 webhook",
    inbound: 42,
    outbound: 12,
    status: "on",
  },
  {
    id: "tg",
    kind: "telegram",
    name: "Telegram",
    glyph: "✈",
    tint: "rgba(34, 158, 217, 0.10)",
    fg: "#1773a0",
    account: "@me_bot",
    hint: "Bot Token",
    inbound: 18,
    outbound: 6,
    status: "on",
  },
  {
    id: "sms",
    kind: "sms",
    name: "短信",
    glyph: "✆",
    tint: "rgba(52, 199, 89, 0.10)",
    fg: "#1c8939",
    account: "+86 138 ****",
    hint: "通过 macOS 信使转发",
    inbound: 3,
    outbound: 0,
    status: "off",
  },
  {
    id: "webhook",
    kind: "webhook",
    name: "通用 Webhook",
    glyph: "⚡",
    tint: "rgba(124, 58, 237, 0.10)",
    fg: "#5b29b8",
    account: "6 个端点",
    hint: "签名校验已开启",
    inbound: 220,
    outbound: 0,
    status: "on",
  },
];

interface RuleSpec {
  id: string;
  name: string;
  from: string;
  when: string;
  to: string;
  on: boolean;
}

const RULES: ReadonlyArray<RuleSpec> = [
  { id: "r1", name: "紧急邮件 → 写作助手",   from: "Gmail",        when: "主题含「紧急」或来自家人",   to: "写作助手 · 立即回复",    on: true  },
  { id: "r2", name: "订阅周报 → 调研员",     from: "Gmail",        when: "发件人在订阅列表中",         to: "调研员 · 摘要后归档",   on: true  },
  { id: "r3", name: "飞书群 @我 → 助手",     from: "飞书",          when: "机器人收到 @ 提及",           to: "写作助手 · 草拟回复",   on: true  },
  { id: "r4", name: "部署告警 → Shell 助理", from: "通用 Webhook", when: "path = /alert/deploy",       to: "Shell 助理 · 立即处理", on: true  },
  { id: "r5", name: "Telegram → 周计划",     from: "Telegram",     when: "私聊命令以 /todo 开头",       to: "周计划 · 加入今日",     on: false },
];

export function ChannelsSection() {
  const connectedCount = CHANNELS.filter((c) => c.status === "on").length;
  return (
    <SettingsSection
      title="消息渠道"
      description="把外部消息接入工作台 — 邮件、IM、短信、Webhook 都可以触发智能体回复或执行任务。"
    >
      <SectionGroup
        title="已连接渠道"
        hint={`${connectedCount} / ${CHANNELS.length} 已启用`}
      >
        <ul className="channel-grid">
          {CHANNELS.map((c) => (
            <ChannelCard key={c.id} channel={c} />
          ))}
          <li className="channel-card channel-card-add" aria-disabled="true">
            <span className="channel-card-add-glyph" aria-hidden="true">
              +
            </span>
            <span className="channel-card-add-title">添加渠道</span>
            <span className="channel-card-add-hint">
              Gmail · 飞书 · Slack · Telegram · IMAP · Webhook
            </span>
          </li>
        </ul>
      </SectionGroup>

      <SectionGroup title="路由规则" hint="按顺序匹配；命中即停止。">
        <ul className="rule-list">
          {RULES.map((r, i) => (
            <li key={r.id} className={"rule-row" + (r.on ? "" : " off")}>
              <span className="rule-no" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="rule-body">
                <div className="rule-name">{r.name}</div>
                <div className="rule-flow">
                  <span className="rule-from">{r.from}</span>
                  <span className="rule-when">{r.when}</span>
                  <span className="rule-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="rule-to">{r.to}</span>
                </div>
              </div>
              <DisabledToggle on={r.on} />
              <button
                type="button"
                className="rule-edit"
                disabled
                title="编辑"
                aria-label={`编辑规则 ${r.name}`}
              >
                …
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn-secondary btn-sm rule-add" disabled>
          + 新建规则
        </button>
      </SectionGroup>

      <SectionGroup title="行为">
        <FormRow label="未路由的消息" hint="没有任何规则匹配时怎么办。">
          <DisabledSelect value="inbox">
            <option value="inbox">推给收件箱</option>
            <option value="ignore">忽略</option>
            <option value="default">交给默认助手</option>
          </DisabledSelect>
        </FormRow>
        <FormRow label="自动回复时长" hint="收到消息后等待多久才发出回复，避免「秒回」。">
          <span className="mini-field">~2 分钟</span>
        </FormRow>
        <FormRow label="安静时段内" hint="参见 通用 → 安静时段。">
          <DisabledSelect value="queue">
            <option value="queue">入队，醒后处理</option>
            <option value="urgent">仅紧急放行</option>
            <option value="silent">全部静默</option>
          </DisabledSelect>
        </FormRow>
      </SectionGroup>

      <p className="settings-shell-note">
        消息渠道与路由规则均为 UI 预览，后端尚未启用；启用后将以本机隔离方式运行。
      </p>
    </SettingsSection>
  );
}

function ChannelCard({ channel }: { channel: ChannelSpec }) {
  const isOn = channel.status === "on";
  return (
    <li className={"channel-card" + (isOn ? "" : " channel-card-off")}>
      <header className="channel-card-head">
        <span
          className="channel-card-glyph"
          style={{ background: channel.tint, color: channel.fg }}
          aria-hidden="true"
        >
          {channel.glyph}
        </span>
        <div className="channel-card-titles">
          <h4 className="channel-card-title">{channel.name}</h4>
          <p className="channel-card-account">{channel.account}</p>
        </div>
        <span
          className={"provider-status" + (isOn ? " on" : " off")}
          aria-label={isOn ? "已连接" : "未启用"}
        >
          {isOn ? "已连接" : "未启用"}
        </span>
      </header>

      <p className="channel-card-hint">{channel.hint}</p>

      <dl className="channel-card-stats" aria-label="本月流量">
        <div className="channel-card-stat">
          <dt>
            <span aria-hidden="true">↓</span>
            <span className="visually-hidden">收</span>
          </dt>
          <dd className="num">{channel.inbound}</dd>
        </div>
        <div className="channel-card-stat">
          <dt>
            <span aria-hidden="true">↑</span>
            <span className="visually-hidden">发</span>
          </dt>
          <dd className="num">{channel.outbound}</dd>
        </div>
        <div className="channel-card-stat-meta">本月</div>
      </dl>

      <footer className="channel-card-foot">
        <DisabledToggle on={isOn} />
        <button type="button" className="btn-secondary btn-sm" disabled>
          配置
        </button>
      </footer>
    </li>
  );
}
