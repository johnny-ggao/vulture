# Vulture Browser Relay Extension

Load this folder as an unpacked Chrome extension for local development.

The current slice provides the MV3 skeleton, tab listing, pairing-token storage,
and a local polling relay for `browser.snapshot`, `browser.click`,
`browser.input`, `browser.scroll`, and `browser.extract`.

Pairing flow:

1. In Vulture, start browser pairing and copy the returned relay port + token.
2. In the extension popup, paste the relay port and token, then click Pair.
3. The background worker polls `http://127.0.0.1:<port>/browser/requests` and
   posts action results back to the shell callback server.

Supported active-tab actions:

- `browser.snapshot`: return title, URL, and visible body text.
- `browser.click`: click a CSS selector.
- `browser.input`: set text on a CSS selector and optionally submit.
- `browser.scroll`: scroll the page or a selected element.
- `browser.extract`: return title, URL, visible text, and page links.

The production encrypted frame transport and broader CDP forwarding are
implemented in later hardening tasks.
