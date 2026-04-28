import { describe, expect, test } from "bun:test";
import {
  formatMemoriesForPrompt,
  normalizeMemoryKeywords,
  retrieveRelevantMemories,
  type SearchableMemory,
} from "./memoryRetrieval";

const memories: SearchableMemory[] = [
  {
    id: "mem-a",
    content: "User prefers concise Chinese answers.",
    keywords: ["user", "prefers", "concise", "chinese", "answers"],
    embedding: [1, 0],
  },
  {
    id: "mem-b",
    content: "Project codename is Vulture.",
    keywords: ["project", "codename", "vulture"],
    embedding: [0, 1],
  },
  {
    id: "mem-c",
    content: "Favorite database is SQLite.",
    keywords: ["favorite", "database", "sqlite"],
    embedding: null,
  },
];

describe("memory retrieval", () => {
  test("normalizes memory keywords for deterministic fallback search", () => {
    expect(normalizeMemoryKeywords("Project: Vulture, vulture; SQLite!")).toEqual([
      "project",
      "vulture",
      "sqlite",
    ]);
  });

  test("uses keyword fallback when no query embedding is available", async () => {
    const results = await retrieveRelevantMemories({
      input: "Please use concise Chinese answers",
      memories,
      topK: 5,
      embed: async () => null,
    });

    expect(results.map((result) => result.memory.id)).toEqual(["mem-a"]);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].source).toBe("keywords");
  });

  test("keyword fallback matches Chinese memories with overlapping phrases", async () => {
    const results = await retrieveRelevantMemories({
      input: "请简洁中文回答",
      memories: [
        {
          id: "mem-zh",
          content: "用户喜欢简洁中文回答",
          keywords: normalizeMemoryKeywords("用户喜欢简洁中文回答"),
          embedding: null,
        },
      ],
      topK: 5,
      embed: async () => null,
    });

    expect(results.map((result) => result.memory.id)).toEqual(["mem-zh"]);
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("keyword fallback retrieves a Chinese project codename memory", async () => {
    const results = await retrieveRelevantMemories({
      input: "项目代号是什么？请简单回答",
      memories: [
        {
          id: "mem-codename",
          content: "用户喜欢简洁中文回答，并且项目代号是 Vulture。",
          keywords: normalizeMemoryKeywords("用户喜欢简洁中文回答，并且项目代号是 Vulture。"),
          embedding: null,
        },
      ],
      topK: 5,
      embed: async () => null,
    });

    expect(results.map((result) => result.memory.id)).toEqual(["mem-codename"]);
    expect(formatMemoriesForPrompt(results)).toContain("项目代号是 Vulture");
  });

  test("keyword fallback reindexes memory content when stored keywords are stale", async () => {
    const results = await retrieveRelevantMemories({
      input: "项目代号是什么？请简单回答",
      memories: [
        {
          id: "mem-stale-keywords",
          content: "用户喜欢简洁中文回答，并且项目代号是 Vulture。",
          keywords: ["用户喜欢简洁中文回答", "并且项目代号是", "vulture"],
          embedding: null,
        },
      ],
      topK: 5,
      embed: async () => null,
    });

    expect(results.map((result) => result.memory.id)).toEqual(["mem-stale-keywords"]);
  });

  test("uses cosine similarity when query and stored embeddings are available", async () => {
    const results = await retrieveRelevantMemories({
      input: "What is the project codename?",
      memories,
      topK: 2,
      embed: async () => [0.1, 0.9],
    });

    expect(results.map((result) => result.memory.id)).toEqual(["mem-b", "mem-a"]);
    expect(results[0].source).toBe("embedding");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test("falls back to keywords when embedding provider throws", async () => {
    const results = await retrieveRelevantMemories({
      input: "sqlite database",
      memories,
      topK: 5,
      embed: async () => {
        throw new Error("embedding failed");
      },
    });

    expect(results.map((result) => result.memory.id)).toEqual(["mem-c"]);
    expect(results[0].source).toBe("keywords");
  });

  test("formats memories as compact XML and escapes content", () => {
    const prompt = formatMemoriesForPrompt([
      {
        memory: {
          id: "mem-1",
          content: "Use <short> answers & Chinese.",
          keywords: [],
          embedding: null,
        },
        score: 1,
        source: "keywords",
      },
    ]);

    expect(prompt).toContain("authoritative user/project context");
    expect(prompt).toContain("<memories>");
    expect(prompt).toContain('<memory id="mem-1">Use &lt;short&gt; answers &amp; Chinese.</memory>');
    expect(prompt).toContain("</memories>");
  });
});
