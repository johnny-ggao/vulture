import {
  DisabledSelect,
  DisabledToggle,
  FormRow,
  SectionGroup,
} from "./GeneralSection";

/* ============================================================
 * ChannelsSection (C2)
 *
 * UI shell for the routing-rules surface described in the kit. Channels
 * connect external inboxes (Gmail, 飞书, Telegram, SMS, Webhook) to
 * agents via numbered routing rules. Backend wiring is not yet in
 * place — every control here is a non-functional placeholder so users
 * can see where the affordance will land.
 * ============================================================ */

const CHANNELS = [
  { id: "gmail",   kind: "gmail",    name: "Gmail",        glyph: "✉", account: "me@example.com",       inbound: 124, outbound: 38, status: "on",  hint: "IMAP + 应用专用密码" },
  { id: "feishu",  kind: "feishu",   name: "飞书",         glyph: "飞", account: "王同学（个人）",        inbound: 42,  outbound: 12, status: "on",  hint: "机器人 webhook" },
  { id: "tg",      kind: "telegram", name: "Telegram",     glyph: "✈", account: "@me_bot",               inbound: 18,  outbound: 6,  status: "on",  hint: "Bot Token" },
  { id: "sms",     kind: "sms",      name: "短信",         glyph: "✆", account: "+86 138 ****",          inbound: 3,   outbound: 0,  status: "off", hint: "通过 macOS 信使转发" },
  { id: "webhook", kind: "webhook",  name: "通用 Webhook", glyph: "⚡", account: "6 个端点",              inbound: 220, outbound: 0,  status: "on",  hint: "签名校验已开启" },
] as const;

const RULES = [
  { id: "r1", name: "紧急邮件 → 写作助手",   from: "Gmail",        when: "主题含「紧急」或来自家人",   to: "写作助手 · 立即回复",    on: true  },
  { id: "r2", name: "订阅周报 → 调研员",     from: "Gmail",        when: "发件人在订阅列表中",         to: "调研员 · 摘要后归档",   on: true  },
  { id: "r3", name: "飞书群 @我 → 助手",     from: "飞书",          when: "机器人收到 @ 提及",           to: "写作助手 · 草拟回复",   on: true  },
  { id: "r4", name: "部署告警 → Shell 助理", from: "通用 Webhook", when: "path = /alert/deploy",       to: "Shell 助理 · 立即处理", on: true  },
  { id: "r5", name: "Telegram → 周计划",     from: "Telegram",     when: "私聊命令以 /todo 开头",       to: "周计划 · 加入今日",     on: false },
] as const;

export function ChannelsSection() {
  return (
    <>
      <header className="model-panel-head">
        <h2 className="model-panel-title">消息渠道</h2>
        <p className="model-panel-sub">
          把外部消息接入工作台 — 邮件、IM、短信、Webhook 都可以触发智能体回复或执行任务。
        </p>
      </header>

      <SectionGroup title="已连接渠道">
        <ul className="inbox-list">
          {CHANNELS.map((c) => (
            <li key={c.id} className="inbox-row">
              <span className="inbox-glyph" aria-hidden="true">{c.glyph}</span>
              <div className="inbox-text">
                <div className="inbox-line">
                  <span className="inbox-name">{c.name}</span>
                  <span className={"provider-status" + (c.status === "on" ? " on" : " off")}>
                    {c.status === "on" ? "已连接" : "未启用"}
                  </span>
                </div>
                <div className="inbox-meta">{c.account} · {c.hint}</div>
                <div className="inbox-stats">
                  <span>↓ <b>{c.inbound}</b> 收</span>
                  <span>↑ <b>{c.outbound}</b> 发</span>
                  <span>本月</span>
                </div>
              </div>
              <div className="inbox-actions">
                <DisabledToggle on={c.status === "on"} />
                <button type="button" className="btn-secondary btn-sm" disabled>配置</button>
              </div>
            </li>
          ))}
          <li className="inbox-add">
            <span className="inbox-add-text">+ 添加渠道</span>
            <span className="inbox-add-hint">Gmail · 飞书 · Slack · Telegram · IMAP · Webhook</span>
          </li>
        </ul>
      </SectionGroup>

      <SectionGroup title="路由规则" hint="按顺序匹配；命中即停止。">
        <ul className="rule-list">
          {RULES.map((r, i) => (
            <li key={r.id} className={"rule-row" + (r.on ? "" : " off")}>
              <span className="rule-no">{String(i + 1).padStart(2, "0")}</span>
              <div className="rule-body">
                <div className="rule-name">{r.name}</div>
                <div className="rule-flow">
                  <span className="rule-from">{r.from}</span>
                  <span className="rule-when">{r.when}</span>
                  <span className="rule-arrow">→</span>
                  <span className="rule-to">{r.to}</span>
                </div>
              </div>
              <DisabledToggle on={r.on} />
              <button type="button" className="rule-edit" disabled title="编辑">…</button>
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
    </>
  );
}
