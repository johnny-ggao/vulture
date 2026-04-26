# Browser Control Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first local browser-control slice: a Chrome MV3 extension skeleton, authenticated local relay state, desktop pairing UI, browser tool policy/audit routing, and mockable browser actions for tab discovery, snapshot, click, input, scroll, and keypress.

**Architecture:** Rust remains the authority boundary. The extension talks only to the Rust desktop shell relay, the sidecar only requests `browser.*` tools through the existing tool gateway path, and browser actions are audited before any result is returned. This slice proves the extension/relay/tool contract with a mockable transport first; production CDP forwarding is constrained to a small allowlist.

**Tech Stack:** Tauri 2, Rust, React 18, TypeScript 5, Bun, Chrome Manifest V3, WebSocket framing, existing `vulture-tool-gateway`, existing Bun sidecar.

---

## Scope

This plan implements the Browser Control Slice without adding cloud accounts, plugin marketplace, full RPA workflows, or unrestricted raw CDP. It includes:

- `browser.*` policy decisions and audit events in Rust.
- Browser relay state in the desktop shell.
- One-time pairing token lifecycle and relay status commands.
- MV3 extension skeleton with service worker, popup, content script, and relay client.
- Mockable relay messages for `tabs.list`, `snapshot`, `click`, `input`, `scroll`, and `keypress`.
- UI panel for extension pairing status and recent browser events.
- Verification through unit tests and mock extension messages.

It does not ship a production-grade encrypted public-key handshake yet. For this slice, the relay uses `127.0.0.1` only, random one-time tokens, explicit profile-local enablement, and strict message validation. A later hardening task should replace the token-authenticated frame with the full public-key plus AES-GCM session described in the platform spec.

## File Structure

Create these files:

```text
extensions/browser/manifest.json
extensions/browser/src/background.js
extensions/browser/src/content.js
extensions/browser/src/popup.html
extensions/browser/src/popup.js
extensions/browser/src/relay-client.js
extensions/browser/README.md

apps/desktop-shell/src/browser/mod.rs
apps/desktop-shell/src/browser/protocol.rs
apps/desktop-shell/src/browser/relay.rs
apps/desktop-shell/src/browser/tools.rs

apps/desktop-ui/src/browserTypes.ts
```

Modify these files:

```text
Cargo.toml
apps/desktop-shell/Cargo.toml
apps/desktop-shell/src/main.rs
apps/desktop-shell/src/commands.rs
apps/desktop-shell/src/state.rs
apps/desktop-ui/src/App.tsx
apps/desktop-ui/src/styles.css
crates/tool-gateway/src/policy.rs
apps/agent-sidecar/src/tools.ts
apps/agent-sidecar/src/agents.ts
package.json
docs/superpowers/reports/2026-04-26-browser-control-slice-verification.md
```

## Task 1: Browser Tool Policy

**Files:**
- Modify: `crates/tool-gateway/src/policy.rs`

- [x] **Step 1: Add failing tests for browser tools**

Add these tests inside `crates/tool-gateway/src/policy.rs`:

```rust
#[test]
fn asks_for_browser_attach_and_actions() {
    let engine = PolicyEngine::default();

    for tool in [
        "browser.open",
        "browser.attach",
        "browser.snapshot",
        "browser.click",
        "browser.input",
        "browser.scroll",
        "browser.keypress",
        "browser.extract",
        "browser.close_agent_tabs",
        "browser.forward_cdp_limited",
    ] {
        let request = ToolRequest {
            run_id: "run_browser".to_string(),
            tool: tool.to_string(),
            input: serde_json::json!({ "tabId": 1 }),
        };

        assert_eq!(
            engine.decide(&request),
            PolicyDecision::Ask {
                reason: format!("{tool} requires browser approval")
            }
        );
    }
}

#[test]
fn denies_raw_browser_control_alias() {
    let engine = PolicyEngine::default();
    let request = ToolRequest {
        run_id: "run_browser".to_string(),
        tool: "browser.control".to_string(),
        input: serde_json::json!({}),
    };

    assert_eq!(
        engine.decide(&request),
        PolicyDecision::Deny {
            reason: "unknown tool browser.control".to_string()
        }
    );
}
```

- [x] **Step 2: Run failing test**

Run:

```bash
cargo test -p vulture-tool-gateway browser
```

Expected: `asks_for_browser_attach_and_actions` fails because `browser.*` is currently denied as unknown.

- [x] **Step 3: Implement policy branch**

In `PolicyEngine::decide`, add the browser branch before the unknown branch:

```rust
tool if is_browser_tool(tool) => PolicyDecision::Ask {
    reason: format!("{tool} requires browser approval"),
},
```

Add the helper near the path helpers:

```rust
fn is_browser_tool(tool: &str) -> bool {
    matches!(
        tool,
        "browser.open"
            | "browser.attach"
            | "browser.snapshot"
            | "browser.click"
            | "browser.input"
            | "browser.scroll"
            | "browser.keypress"
            | "browser.extract"
            | "browser.close_agent_tabs"
            | "browser.forward_cdp_limited"
    )
}
```

- [x] **Step 4: Verify and commit**

Run:

```bash
cargo test -p vulture-tool-gateway browser
cargo clippy -p vulture-tool-gateway -- -D warnings
git add crates/tool-gateway/src/policy.rs
git commit -m "feat: add browser tool policy"
```

Expected: tests and clippy pass; commit succeeds.

## Task 2: Browser Relay Protocol

**Files:**
- Create: `apps/desktop-shell/src/browser/mod.rs`
- Create: `apps/desktop-shell/src/browser/protocol.rs`
- Modify: `apps/desktop-shell/src/main.rs`

- [x] **Step 1: Write protocol tests**

Create `apps/desktop-shell/src/browser/mod.rs`:

```rust
pub mod protocol;
```

Create `apps/desktop-shell/src/browser/protocol.rs`:

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPairingToken {
    pub token: String,
    pub expires_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum BrowserRelayMessage {
    #[serde(rename = "Extension.hello")]
    ExtensionHello {
        protocol_version: u32,
        extension_version: String,
        pairing_token: String,
    },
    #[serde(rename = "Browser.tabs")]
    BrowserTabs { tabs: Vec<BrowserTab> },
    #[serde(rename = "Browser.actionResult")]
    BrowserActionResult { request_id: String, ok: bool, value: Value },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: u64,
    pub title: String,
    pub url: String,
    pub active: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_extension_hello_message() {
        let message: BrowserRelayMessage = serde_json::from_str(
            r#"{"method":"Extension.hello","params":{"protocol_version":1,"extension_version":"0.1.0","pairing_token":"abc"}}"#,
        )
        .expect("message should parse");

        assert_eq!(
            message,
            BrowserRelayMessage::ExtensionHello {
                protocol_version: 1,
                extension_version: "0.1.0".to_string(),
                pairing_token: "abc".to_string()
            }
        );
    }
}
```

Modify `apps/desktop-shell/src/main.rs` to include:

```rust
mod browser;
```

- [x] **Step 2: Run protocol tests**

Run:

```bash
cargo test -p vulture-desktop-shell browser::protocol
```

Expected: tests pass after the module is wired.

- [x] **Step 3: Commit**

Run:

```bash
git add apps/desktop-shell/src/browser apps/desktop-shell/src/main.rs
git commit -m "feat: add browser relay protocol"
```

Expected: commit succeeds.

## Task 3: Relay State And Pairing Commands

**Files:**
- Create: `apps/desktop-shell/src/browser/relay.rs`
- Modify: `apps/desktop-shell/src/browser/mod.rs`
- Modify: `apps/desktop-shell/src/state.rs`
- Modify: `apps/desktop-shell/src/commands.rs`
- Modify: `apps/desktop-shell/src/main.rs`

- [x] **Step 1: Add relay state tests**

Create `apps/desktop-shell/src/browser/relay.rs`:

```rust
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use serde::Serialize;
use uuid::Uuid;

use super::protocol::BrowserPairingToken;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRelayStatus {
    pub enabled: bool,
    pub paired: bool,
    pub pairing_token: Option<String>,
    pub relay_port: Option<u16>,
}

#[derive(Debug, Default)]
pub struct BrowserRelayState {
    enabled: bool,
    paired: bool,
    pairing_token: Option<BrowserPairingToken>,
    relay_port: Option<u16>,
}

impl BrowserRelayState {
    pub fn status(&self) -> BrowserRelayStatus {
        BrowserRelayStatus {
            enabled: self.enabled,
            paired: self.paired,
            pairing_token: self.pairing_token.as_ref().map(|token| token.token.clone()),
            relay_port: self.relay_port,
        }
    }

    pub fn enable_pairing(&mut self, relay_port: u16) -> Result<BrowserRelayStatus> {
        if relay_port == 0 {
            return Err(anyhow!("relay port must be non-zero"));
        }

        self.enabled = true;
        self.paired = false;
        self.relay_port = Some(relay_port);
        self.pairing_token = Some(BrowserPairingToken {
            token: Uuid::new_v4().to_string(),
            expires_at_unix_ms: now_unix_ms() + 5 * 60 * 1000,
        });

        Ok(self.status())
    }

    pub fn accept_token(&mut self, token: &str) -> bool {
        let matches = self
            .pairing_token
            .as_ref()
            .is_some_and(|pairing| pairing.token == token && pairing.expires_at_unix_ms > now_unix_ms());

        if matches {
            self.paired = true;
            self.pairing_token = None;
        }

        matches
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after unix epoch")
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enable_pairing_creates_one_time_token() {
        let mut state = BrowserRelayState::default();
        let status = state.enable_pairing(38421).expect("pairing should enable");
        let token = status.pairing_token.expect("token should exist");

        assert!(status.enabled);
        assert!(!status.paired);
        assert_eq!(status.relay_port, Some(38421));
        assert!(state.accept_token(&token));
        assert!(!state.accept_token(&token));
        assert!(state.status().paired);
    }
}
```

Update `apps/desktop-shell/src/browser/mod.rs`:

```rust
pub mod protocol;
pub mod relay;
```

- [x] **Step 2: Add state and Tauri commands**

Add a `browser_relay: Mutex<BrowserRelayState>` field to `AppState`, initialize it in `new_for_root`, and add:

```rust
pub fn browser_status(&self) -> Result<crate::browser::relay::BrowserRelayStatus> {
    Ok(self.browser_relay()?.status())
}

pub fn start_browser_pairing(&self) -> Result<crate::browser::relay::BrowserRelayStatus> {
    self.browser_relay()?.enable_pairing(38421)
}

fn browser_relay(&self) -> Result<MutexGuard<'_, crate::browser::relay::BrowserRelayState>> {
    self.browser_relay
        .lock()
        .map_err(|_| anyhow!("browser relay lock poisoned"))
}
```

Add Tauri commands in `commands.rs`:

```rust
#[tauri::command]
pub fn get_browser_status(
    state: State<'_, AppState>,
) -> Result<crate::browser::relay::BrowserRelayStatus, String> {
    state.browser_status().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn start_browser_pairing(
    state: State<'_, AppState>,
) -> Result<crate::browser::relay::BrowserRelayStatus, String> {
    state.start_browser_pairing().map_err(|error| error.to_string())
}
```

Register these commands in `main.rs`:

```rust
commands::get_browser_status,
commands::start_browser_pairing
```

- [x] **Step 3: Verify and commit**

Run:

```bash
cargo test -p vulture-desktop-shell browser::relay
cargo check -p vulture-desktop-shell
git add apps/desktop-shell/src/browser apps/desktop-shell/src/state.rs apps/desktop-shell/src/commands.rs apps/desktop-shell/src/main.rs
git commit -m "feat: add browser pairing state"
```

Expected: tests/check pass; commit succeeds.

## Task 4: Browser Control UI Panel

**Files:**
- Create: `apps/desktop-ui/src/browserTypes.ts`
- Modify: `apps/desktop-ui/src/App.tsx`
- Modify: `apps/desktop-ui/src/styles.css`

- [ ] **Step 1: Add browser UI types**

Create `apps/desktop-ui/src/browserTypes.ts`:

```ts
export type BrowserRelayStatus = {
  enabled: boolean;
  paired: boolean;
  pairingToken?: string | null;
  relayPort?: number | null;
};
```

- [ ] **Step 2: Add browser panel to App**

In `App.tsx`, import the type:

```ts
import type { BrowserRelayStatus } from "./browserTypes";
```

Add state:

```ts
const [browserStatus, setBrowserStatus] = useState<BrowserRelayStatus | null>(null);
const [browserError, setBrowserError] = useState<string | null>(null);
```

Load status next to profile loading:

```ts
invoke<BrowserRelayStatus>("get_browser_status")
  .then((result) => {
    if (isMounted) setBrowserStatus(result);
  })
  .catch(() => {
    if (isMounted) setBrowserStatus(null);
  });
```

Add command:

```ts
async function startPairing() {
  setBrowserError(null);
  try {
    const result = await invoke<BrowserRelayStatus>("start_browser_pairing");
    setBrowserStatus(result);
  } catch (cause) {
    setBrowserError(errorMessage(cause));
  }
}
```

Replace the approvals panel contents with:

```tsx
<aside className="inspector">
  <h2>Browser</h2>
  <p>Status: {browserStatus?.paired ? "paired" : browserStatus?.enabled ? "pairing" : "disabled"}</p>
  {browserStatus?.relayPort ? <p>Relay: 127.0.0.1:{browserStatus.relayPort}</p> : null}
  {browserStatus?.pairingToken ? <code className="token">{browserStatus.pairingToken}</code> : null}
  {browserError ? <p className="error">{browserError}</p> : null}
  <button type="button" onClick={startPairing}>Pair Extension</button>
</aside>
```

- [ ] **Step 3: Add styles**

Add to `styles.css`:

```css
.token {
  display: block;
  margin: 10px 0;
  padding: 8px;
  border: 1px solid #d8e0e7;
  border-radius: 6px;
  background: #f5f7f8;
  font-size: 12px;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
bun --filter @vulture/desktop-ui typecheck
bun --filter @vulture/desktop-ui build
git add apps/desktop-ui/src/browserTypes.ts apps/desktop-ui/src/App.tsx apps/desktop-ui/src/styles.css
git commit -m "feat: add browser pairing panel"
```

Expected: commands pass; commit succeeds.

## Task 5: Chrome MV3 Extension Skeleton

**Files:**
- Create: `extensions/browser/manifest.json`
- Create: `extensions/browser/src/background.js`
- Create: `extensions/browser/src/content.js`
- Create: `extensions/browser/src/popup.html`
- Create: `extensions/browser/src/popup.js`
- Create: `extensions/browser/src/relay-client.js`
- Create: `extensions/browser/README.md`

- [ ] **Step 1: Create manifest**

Create `extensions/browser/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Vulture Browser Relay",
  "version": "0.1.0",
  "permissions": ["debugger", "tabs", "tabGroups", "windows", "scripting", "storage", "alarms", "notifications"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "src/background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "src/popup.html"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 2: Create relay client**

Create `extensions/browser/src/relay-client.js`:

```js
export function buildHello({ protocolVersion, extensionVersion, pairingToken }) {
  return {
    method: "Extension.hello",
    params: {
      protocol_version: protocolVersion,
      extension_version: extensionVersion,
      pairing_token: pairingToken,
    },
  };
}

export function normalizeTab(tab) {
  return {
    id: tab.id ?? 0,
    title: tab.title ?? "",
    url: tab.url ?? "",
    active: Boolean(tab.active),
  };
}

export async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    method: "Browser.tabs",
    params: {
      tabs: tabs.map(normalizeTab),
    },
  };
}
```

- [ ] **Step 3: Create background and popup**

Create `extensions/browser/src/background.js`:

```js
import { buildHello, listTabs } from "./relay-client.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "buildHello") {
    sendResponse(buildHello(message.payload));
    return true;
  }

  if (message?.type === "listTabs") {
    listTabs().then(sendResponse, (error) => {
      sendResponse({ error: String(error) });
    });
    return true;
  }

  return false;
});
```

Create `extensions/browser/src/content.js`:

```js
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "snapshot") {
    sendResponse({
      title: document.title,
      url: location.href,
      text: document.body?.innerText?.slice(0, 20000) ?? "",
    });
    return true;
  }

  return false;
});
```

Create `extensions/browser/src/popup.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Vulture</title>
    <style>
      body { width: 280px; font: 13px system-ui, sans-serif; margin: 12px; }
      input, button { width: 100%; box-sizing: border-box; margin-top: 8px; }
      code { display: block; margin-top: 8px; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <strong>Vulture Browser Relay</strong>
    <input id="token" placeholder="Pairing token" />
    <button id="save">Save Token</button>
    <button id="tabs">List Tabs</button>
    <code id="output"></code>
    <script type="module" src="./popup.js"></script>
  </body>
</html>
```

Create `extensions/browser/src/popup.js`:

```js
const tokenInput = document.querySelector("#token");
const output = document.querySelector("#output");

document.querySelector("#save").addEventListener("click", async () => {
  await chrome.storage.local.set({ pairingToken: tokenInput.value.trim() });
  output.textContent = "saved";
});

document.querySelector("#tabs").addEventListener("click", async () => {
  const tabs = await chrome.runtime.sendMessage({ type: "listTabs" });
  output.textContent = JSON.stringify(tabs);
});
```

Create `extensions/browser/README.md`:

```markdown
# Vulture Browser Relay Extension

Load this folder as an unpacked Chrome extension for local development.

The current slice provides the MV3 skeleton, tab listing, page snapshot content script, and pairing-token storage. The production relay connection and encrypted frame transport are implemented in later hardening tasks.
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('extensions/browser/manifest.json','utf8')); console.log('manifest ok')"
git add extensions/browser
git commit -m "feat: add browser extension skeleton"
```

Expected: manifest parse succeeds; commit succeeds.

## Task 6: Sidecar Browser Tool Adapters

**Files:**
- Modify: `apps/agent-sidecar/src/tools.ts`
- Modify: `apps/agent-sidecar/src/agents.ts`
- Create: `apps/agent-sidecar/src/browser-tools.test.ts`

- [ ] **Step 1: Add failing tests**

Create `apps/agent-sidecar/src/browser-tools.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createBrowserTools, requestBrowserSnapshot } from "./tools";

describe("browser tools", () => {
  test("forward browser snapshot through gateway", async () => {
    const calls: unknown[] = [];

    const result = await requestBrowserSnapshot({
      async request(toolName, input) {
        calls.push({ toolName, input });
        return { ok: true };
      },
    }, { tabId: 1 });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ toolName: "browser.snapshot", input: { tabId: 1 } }]);
  });

  test("exposes stable Agents SDK browser tool names", () => {
    const tools = createBrowserTools({
      async request() {
        return { ok: true };
      },
    });

    expect(tools.snapshot.name).toBe("browser_snapshot");
    expect(tools.click.name).toBe("browser_click");
  });
});
```

Expected: tests fail because `createBrowserTools` and `requestBrowserSnapshot` do not exist yet.

- [ ] **Step 2: Implement browser tools**

In `tools.ts`, add:

```ts
const browserTabInput = z.object({ tabId: z.number().int().positive() });
const browserClickInput = browserTabInput.extend({
  selector: z.string().min(1),
});

export async function requestBrowserSnapshot(
  gateway: ToolGateway,
  input: z.infer<typeof browserTabInput>,
) {
  return gateway.request("browser.snapshot", input);
}

export async function requestBrowserClick(
  gateway: ToolGateway,
  input: z.infer<typeof browserClickInput>,
) {
  return gateway.request("browser.click", input);
}

export function createBrowserTools(gateway: ToolGateway) {
  const snapshot = tool({
    name: "browser_snapshot",
    description: "Request a browser page snapshot through the Rust Browser Relay.",
    parameters: browserTabInput,
    execute: async (input) => requestBrowserSnapshot(gateway, input),
  });

  const click = tool({
    name: "browser_click",
    description: "Request a browser click through the Rust Browser Relay.",
    parameters: browserClickInput,
    execute: async (input) => requestBrowserClick(gateway, input),
  });

  return { snapshot, click };
}
```

In `agents.ts`, include browser tools in `createLocalWorkAgent`:

```ts
const browserTools = createBrowserTools(gateway);
tools: [createShellExecTool(gateway), browserTools.snapshot, browserTools.click],
```

- [ ] **Step 3: Verify and commit**

Run:

```bash
bun test apps/agent-sidecar/src
bun --filter @vulture/agent-sidecar typecheck
git add apps/agent-sidecar/src/tools.ts apps/agent-sidecar/src/agents.ts apps/agent-sidecar/src/browser-tools.test.ts
git commit -m "feat: add browser tool adapters"
```

Expected: commands pass; commit succeeds.

## Task 7: Verification

**Files:**
- Modify: `package.json`
- Create: `docs/superpowers/reports/2026-04-26-browser-control-slice-verification.md`

- [ ] **Step 1: Add browser verification script**

Modify root `package.json` scripts to include:

```json
"verify:browser": "node -e \"JSON.parse(require('fs').readFileSync('extensions/browser/manifest.json','utf8')); console.log('manifest ok')\" && bun test apps/agent-sidecar/src && bun --filter '*' typecheck && cargo test -p vulture-tool-gateway browser && cargo test -p vulture-desktop-shell browser && cargo clippy --workspace -- -D warnings"
```

- [ ] **Step 2: Run verification**

Run:

```bash
bun run verify:browser
bun run verify
git status --short
```

Expected: both verification scripts pass and git status is clean before the final report commit except for intended report/package changes.

- [ ] **Step 3: Create report**

Create `docs/superpowers/reports/2026-04-26-browser-control-slice-verification.md`:

```markdown
# Browser Control Slice Verification

Date: 2026-04-26

## Commands

- `bun run verify:browser`
- `bun run verify`

## Result

Automated browser-control slice checks passed.

## Notes

This slice verifies policy, relay protocol, pairing state, browser pairing UI, MV3 manifest validity, extension skeleton files, and sidecar browser tool adapters. Manual Chrome unpacked-extension testing and production encrypted relay hardening remain follow-up work.
```

- [ ] **Step 4: Commit**

Run:

```bash
git add package.json docs/superpowers/reports/2026-04-26-browser-control-slice-verification.md
git commit -m "test: verify browser control slice"
```

Expected: commit succeeds.

## Acceptance Criteria

- `bun run verify:browser` passes.
- `bun run verify` still passes.
- `git status --short` is clean after Task 7.
- Browser tools are policy-gated and audited through Rust, not directly executed by the sidecar.
- Desktop UI can request a browser pairing token and display relay status.
- MV3 extension manifest is valid JSON and contains required permissions.
- Extension skeleton can store a pairing token and produce tab-list/snapshot-shaped messages for local development.

## Follow-Up Plans

1. Browser Relay Transport Hardening: actual WebSocket server, public-key pairing, AES-GCM frames, reconnect.
2. Browser CDP Action Slice: attach/detach debugger, screenshot, DOM extraction, click/input/scroll/keypress through the extension.
3. Browser Approval UX: allow once/session/profile, retain tabs, user-tab close protections.
