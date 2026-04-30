export type DesktopScenarioStep =
  | { action: "launchApp" }
  | { action: "waitForChatReady" }
  | { action: "sendMessage"; text: string }
  | { action: "expectMessage"; text: string }
  | { action: "openNavigation"; label: string }
  | { action: "captureScreenshot"; name: string };

export interface DesktopScenario {
  id: string;
  name: string;
  tags: string[];
  timeoutMs: number;
  steps: DesktopScenarioStep[];
}

export const desktopScenarios: DesktopScenario[] = [
  {
    id: "launch-smoke",
    name: "Launch smoke",
    tags: ["desktop", "smoke"],
    timeoutMs: 60_000,
    steps: [
      { action: "launchApp" },
      { action: "waitForChatReady" },
      { action: "captureScreenshot", name: "chat-ready" },
    ],
  },
  {
    id: "chat-send-smoke",
    name: "Chat send smoke",
    tags: ["desktop", "smoke", "chat"],
    timeoutMs: 90_000,
    steps: [
      { action: "launchApp" },
      { action: "waitForChatReady" },
      { action: "sendMessage", text: "desktop e2e hello" },
      { action: "expectMessage", text: "desktop e2e hello" },
      { action: "captureScreenshot", name: "chat-sent" },
    ],
  },
  {
    id: "navigation-smoke",
    name: "Navigation smoke",
    tags: ["desktop", "navigation"],
    timeoutMs: 90_000,
    steps: [
      { action: "launchApp" },
      { action: "waitForChatReady" },
      { action: "openNavigation", label: "设置" },
      { action: "openNavigation", label: "技能" },
      { action: "openNavigation", label: "智能体" },
      { action: "captureScreenshot", name: "navigation" },
    ],
  },
];
