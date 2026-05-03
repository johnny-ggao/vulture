import { BrandMark } from "./components";

export interface OnboardingCardProps {
  onSignInWithChatGPT: () => Promise<void>;
  onFocusApiKey: () => void;
}

export function OnboardingCard(props: OnboardingCardProps) {
  return (
    <div className="onboarding-card">
      <div className="onboarding-hero">
        <span className="onboarding-kicker">连接方式</span>
        <div className="hero-mark">
          <BrandMark size={64} />
        </div>
        <h2>Vulture</h2>
        <p>选择登录方式开始使用</p>
      </div>
      <div className="onboarding-actions">
        <button
          type="button"
          className="onboarding-primary"
          onClick={() => void props.onSignInWithChatGPT()}
        >
          <ZapIcon />
          <div className="onboarding-text">
            <strong>Sign in with ChatGPT</strong>
            <small>用订阅省 API key 费用（推荐）</small>
          </div>
        </button>
        <button
          type="button"
          className="onboarding-secondary"
          onClick={props.onFocusApiKey}
        >
          <KeyIcon />
          <div className="onboarding-text">
            <strong>OpenAI API key</strong>
            <small>按 token 计费</small>
          </div>
        </button>
      </div>
      <div className="onboarding-trust-row" aria-label="登录方式说明">
        <span>本地工作台</span>
        <span>可随时切换</span>
        <span>保留现有模型设置</span>
      </div>
    </div>
  );
}

function ZapIcon() {
  return (
    <svg
      className="onboarding-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg
      className="onboarding-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="M10 13l9-9" />
      <path d="M16 7l3 3" />
      <path d="M14 9l3 3" />
    </svg>
  );
}
