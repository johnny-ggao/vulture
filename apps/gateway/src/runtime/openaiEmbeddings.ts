export interface OpenAIEmbeddingOptions {
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export function makeOpenAIEmbeddingProvider(
  opts: OpenAIEmbeddingOptions = {},
): (input: string) => Promise<number[] | null> {
  return async (input: string) => {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    const f = opts.fetch ?? fetch;
    const res = await f("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_EMBEDDING_MODEL,
        input,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { data?: Array<{ embedding?: unknown }> }
      | null;
    const embedding = body?.data?.[0]?.embedding;
    return Array.isArray(embedding) && embedding.every((item) => typeof item === "number")
      ? embedding
      : null;
  };
}
