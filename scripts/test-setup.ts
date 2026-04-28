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
  const nativeBlob = globalThis.Blob;
  const nativeFile = globalThis.File;
  const nativeFormData = globalThis.FormData;
  const nativeReadableStream = globalThis.ReadableStream;
  const nativeWritableStream = globalThis.WritableStream;
  const nativeTransformStream = globalThis.TransformStream;
  const nativeAbortController = globalThis.AbortController;
  const nativeAbortSignal = globalThis.AbortSignal;
  // Timers — happy-dom replaces setTimeout/setInterval with its virtual-clock
  // implementations that never fire under bun's real-time test runner. Any
  // backend code that relies on them (ApprovalQueue.wait timeout, retry
  // backoff, etc.) hangs the test forever. Keep the native bun timers.
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearInterval = globalThis.clearInterval;
  const nativeQueueMicrotask = globalThis.queueMicrotask;

  GlobalRegistrator.register();

  globalThis.Request = nativeRequest;
  globalThis.Headers = nativeHeaders;
  globalThis.Response = nativeResponse;
  globalThis.fetch = nativeFetch;
  globalThis.Blob = nativeBlob;
  globalThis.File = nativeFile;
  globalThis.FormData = nativeFormData;
  globalThis.ReadableStream = nativeReadableStream;
  globalThis.WritableStream = nativeWritableStream;
  globalThis.TransformStream = nativeTransformStream;
  globalThis.AbortController = nativeAbortController;
  globalThis.AbortSignal = nativeAbortSignal;
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  globalThis.setInterval = nativeSetInterval;
  globalThis.clearInterval = nativeClearInterval;
  globalThis.queueMicrotask = nativeQueueMicrotask;
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
