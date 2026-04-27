export interface OnboardingCardProps {
  onSignInWithChatGPT: () => Promise<void>;
  onFocusApiKey: () => void;
}

export function OnboardingCard(props: OnboardingCardProps) {
  return (
    <div className="onboarding-card">
      <div className="hero-mark">V</div>
      <h2>Vulture</h2>
      <p>选择登录方式开始使用：</p>
      <div className="onboarding-actions">
        <button
          type="button"
          className="onboarding-primary"
          onClick={() => void props.onSignInWithChatGPT()}
        >
          <span className="onboarding-icon" aria-hidden="true">⚡</span>
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
          <span className="onboarding-icon" aria-hidden="true">🔑</span>
          <div className="onboarding-text">
            <strong>OpenAI API key</strong>
            <small>按 token 计费</small>
          </div>
        </button>
      </div>
    </div>
  );
}
