import assert from "node:assert/strict";
import test from "node:test";
import {
  getAvailableModels,
  getModelEndpoints,
} from "../src/provider-models.js";

test("LM Studio uses the native API and lists all installed chat models by key", async () => {
  const urls = [];
  const models = await getAvailableModels({
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "test-key",
    providerName: "lmstudio",
  }, {
    fetchImpl: async (url, options) => {
      urls.push(String(url));
      assert.equal(options.headers.Authorization, "Bearer test-key");
      return new Response(JSON.stringify({
        models: [
          { type: "llm", key: "google/gemma-4-e2b" },
          { type: "llm", key: "meta/llama-3" },
          { type: "llm", key: "qwen/qwen3" },
          { type: "embedding", key: "nomic/embed-text" },
          { type: "llm", key: "mistral/small" },
          { type: "llm", key: "deepseek/r1" },
        ],
      }), { status: 200 });
    },
  });

  assert.deepEqual(urls, ["http://127.0.0.1:1234/api/v1/models"]);
  assert.deepEqual(models, [
    "google/gemma-4-e2b",
    "meta/llama-3",
    "qwen/qwen3",
    "mistral/small",
    "deepseek/r1",
  ]);
});

test("LM Studio falls back to OpenAI-compatible models only when native API is absent", async () => {
  const urls = [];
  const models = await getAvailableModels({
    baseUrl: "http://localhost:1234/v1",
    apiKey: "",
    providerName: "lmstudio",
  }, {
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/api/v1/models")) {
        return new Response("", { status: 404 });
      }
      return new Response(JSON.stringify({
        data: [{ id: "loaded-model" }],
      }), { status: 200 });
    },
  });

  assert.deepEqual(urls, [
    "http://localhost:1234/api/v1/models",
    "http://localhost:1234/v1/models",
  ]);
  assert.deepEqual(models, ["loaded-model"]);
});

test("does not hide LM Studio authentication failures behind a loaded-model fallback", async () => {
  const requested = [];
  await assert.rejects(
    getAvailableModels({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "invalid",
      providerName: "lmstudio",
    }, {
      fetchImpl: async (url) => {
        requested.push(String(url));
        return new Response("", { status: 401 });
      },
    }),
    /HTTP 401/,
  );
  assert.deepEqual(requested, ["http://localhost:1234/api/v1/models"]);
});

test("uses only the configured OpenAI-compatible endpoint for other providers", async () => {
  assert.deepEqual(
    getModelEndpoints("https://api.example/v1", "openai"),
    ["https://api.example/v1/models"],
  );
});
