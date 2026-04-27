import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

if (!(globalThis as { document?: unknown }).document) {
  // Preserve native Web API globals that happy-dom would otherwise replace.
  // This keeps Hono / undici Request/Headers/Response/fetch working correctly
  // in non-DOM tests that share the same bun test process.
  const nativeRequest = globalThis.Request;
  const nativeHeaders = globalThis.Headers;
  const nativeResponse = globalThis.Response;
  const nativeFetch = globalThis.fetch;

  GlobalRegistrator.register();

  globalThis.Request = nativeRequest;
  globalThis.Headers = nativeHeaders;
  globalThis.Response = nativeResponse;
  globalThis.fetch = nativeFetch;
}

// Auto-cleanup after each test so multiple component tests in the same process
// don't accumulate rendered DOM in document.body. testing-library's built-in
// auto-cleanup expects Jest/Vitest globals; bun:test needs explicit wiring.
// We do a manual document.body reset rather than importing
// @testing-library/react's `cleanup` here, because the preload script runs
// from the repo root and can't resolve the workspace-scoped dep.
afterEach(() => {
  if (typeof document !== "undefined" && document.body) {
    document.body.innerHTML = "";
  }
});
