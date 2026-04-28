export interface SearchableMemory {
  id: string;
  content: string;
  keywords: string[];
  embedding: number[] | null;
}

export interface RetrievedMemory {
  memory: SearchableMemory;
  score: number;
  source: "embedding" | "keywords";
}

export interface RetrieveRelevantMemoriesInput {
  input: string;
  memories: readonly SearchableMemory[];
  topK?: number;
  embed?: (input: string) => Promise<number[] | null>;
}

const DEFAULT_TOP_K = 5;

export function normalizeMemoryKeywords(value: string): string[] {
  const seen = new Set<string>();
  const rawTokens = value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const tokens = rawTokens.flatMap(expandToken);
  const result: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

function expandToken(token: string): string[] {
  if (!containsCjk(token)) return [token];
  const chars = Array.from(token);
  if (chars.length < 2) return [token];
  const expanded = [token];
  for (let index = 0; index < chars.length - 1; index += 1) {
    expanded.push(chars.slice(index, index + 2).join(""));
  }
  return expanded;
}

function containsCjk(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

export async function retrieveRelevantMemories(
  input: RetrieveRelevantMemoriesInput,
): Promise<RetrievedMemory[]> {
  const topK = input.topK ?? DEFAULT_TOP_K;
  if (topK <= 0 || input.memories.length === 0) return [];

  const queryEmbedding = await tryEmbed(input.embed, input.input);
  if (queryEmbedding) {
    const ranked = input.memories
      .filter((memory) => memory.embedding && memory.embedding.length === queryEmbedding.length)
      .map((memory) => ({
        memory,
        score: cosineSimilarity(queryEmbedding, memory.embedding as number[]),
        source: "embedding" as const,
      }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
    if (ranked.length > 0) return ranked;
  }

  return keywordSearch(input.input, input.memories, topK);
}

export function formatMemoriesForPrompt(results: readonly RetrievedMemory[]): string {
  if (results.length === 0) return "";
  const lines = [
    "",
    "",
    "The following saved memories are authoritative user/project context for this run. Use them when relevant.",
    "<memories>",
  ];
  for (const result of results) {
    lines.push(
      `  <memory id="${escapeXml(result.memory.id)}">${escapeXml(result.memory.content)}</memory>`,
    );
  }
  lines.push("</memories>");
  return lines.join("\n");
}

export function formatMemoryToolPrompt(summary: string): string {
  const lines = [
    "",
    "",
    "Memory is available for this agent.",
    "",
    "Use memory_search when durable user/project context may help.",
    "Use memory_get to inspect full memory entries before relying on details.",
    "Use memory_append only for approved durable memory updates.",
  ];
  const trimmed = summary.trim();
  if (trimmed) {
    lines.push("", "Memory summary:", truncateSummary(trimmed, 2_000));
  }
  return lines.join("\n");
}

async function tryEmbed(
  embed: ((input: string) => Promise<number[] | null>) | undefined,
  input: string,
): Promise<number[] | null> {
  if (!embed) return null;
  try {
    const vector = await embed(input);
    return Array.isArray(vector) && vector.every((item) => typeof item === "number")
      ? vector
      : null;
  } catch {
    return null;
  }
}

function keywordSearch(
  input: string,
  memories: readonly SearchableMemory[],
  topK: number,
): RetrievedMemory[] {
  const queryTokens = new Set(normalizeMemoryKeywords(input));
  if (queryTokens.size === 0) return [];
  return memories
    .map((memory) => {
      let score = 0;
      for (const keyword of searchableKeywords(memory)) {
        if (queryTokens.has(keyword)) score += 1;
      }
      return { memory, score, source: "keywords" as const };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

function searchableKeywords(memory: SearchableMemory): string[] {
  const seen = new Set<string>();
  const tokens = [
    ...memory.keywords.flatMap((keyword) => normalizeMemoryKeywords(keyword)),
    ...normalizeMemoryKeywords(memory.content),
  ];
  const result: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function truncateSummary(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated]`;
}
