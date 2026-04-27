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
  const nativeReadableStream = globalThis.ReadableStream;
  const nativeWritableStream = globalThis.WritableStream;
  const nativeTransformStream = globalThis.TransformStream;

  GlobalRegistrator.register();

  globalThis.Request = nativeRequest;
  globalThis.Headers = nativeHeaders;
  globalThis.Response = nativeResponse;
  globalThis.fetch = nativeFetch;
  globalThis.ReadableStream = nativeReadableStream;
  globalThis.WritableStream = nativeWritableStream;
  globalThis.TransformStream = nativeTransformStream;
}

// Auto-cleanup after each test so multiple component tests in the same process
// don't accumulate rendered DOM. We use @testing-library/react's cleanup()
// which properly unmounts React component trees and detaches event listeners.
// We import from the `pure` entry point to avoid the auto-setup side-effects
// in the main index.js (it calls beforeAll() at module load time, which bun:test
// rejects outside of describe()). The dynamic import ensures the module is
// loaded after happy-dom has registered `document`, so @testing-library/dom's
// `screen` singleton is initialised with a live document.body.
afterEach(async () => {
  const { cleanup } = await import("@testing-library/react/pure");
  cleanup();
});
