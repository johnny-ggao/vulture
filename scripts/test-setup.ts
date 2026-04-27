import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
