import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";

test("uses OpenAI-compatible provider tool calls and retains conversation", async (t) => {
  const skillsDir = await mkdtemp(join(tmpdir(), "harvis-agent-skills-"));
  t.after(() => rm(skillsDir, { recursive: true, force: true }));
  const payloads = [];
  const responses = [
    {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "create_skill", arguments: '{"name":"daily","instructions":"Plan the day."}' },
          }],
        },
      }],
    },
    { choices: [{ message: { role: "assistant", content: "Skill creada." } }] },
    { choices: [{ message: { role: "assistant", content: "Claro." } }] },
  ];
  let timeout;
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    timeout = milliseconds;
    return originalTimeout(milliseconds);
  });
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    payloads.push(JSON.parse(request.body));
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  });
  let savedSkill;
  const agent = new Agent({
    config: {
      name: "Harvis",
      provider: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-model",
        apiKey: "",
        temperature: 0.2,
        maxTokens: 1000,
      },
    },
    paths: { skillsDir },
    tools: [{
      type: "function",
      function: { name: "create_skill" },
    }],
    handlers: {
      create_skill: async (args) => {
        savedSkill = args.name;
        return "created";
      },
    },
  });

  assert.equal(await agent.reply("Crea una skill para planificar el día"), "Skill creada.");
  assert.equal(savedSkill, "daily");
  assert.equal(payloads[0].max_tokens, 1000);
  assert.equal(timeout, 180_000);
  assert.equal(await agent.reply("Gracias"), "Claro.");
  assert.equal(payloads[0].model, "local-model");
  assert.equal(payloads[0].tools[0].function.name, "create_skill");
  assert.equal(payloads[2].messages.some((message) => message.content === "Crea una skill para planificar el día"), true);
});

test("provides actionable setup guidance when provider has no model loaded", async (t) => {
  const skillsDir = await mkdtemp(join(tmpdir(), "harvis-agent-skills-"));
  t.after(() => rm(skillsDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ error: { message: "No models loaded" } }),
    { status: 400 },
  ));
  const agent = new Agent({
    config: {
      name: "Harvis",
      provider: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "test",
        apiKey: "",
        temperature: 0.1,
        maxTokens: 10,
      },
    },
    paths: { skillsDir },
    handlers: {},
    tools: [],
  });

  await assert.rejects(agent.reply("Hola"), /LM Studio no tiene un modelo cargado/);
});

test("keeps independent conversation histories for different channels and senders", async (t) => {
  const skillsDir = await mkdtemp(join(tmpdir(), "harvis-agent-skills-"));
  t.after(() => rm(skillsDir, { recursive: true, force: true }));
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    const payload = JSON.parse(request.body);
    payloads.push(payload);
    const userMessage = payload.messages.findLast(({ role }) => role === "user");
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: `Echo ${userMessage.content}` } }],
    }), { status: 200 });
  });
  const agent = new Agent({
    config: {
      name: "Harvis",
      provider: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-model",
        apiKey: "",
        temperature: 0,
        maxTokens: 128,
      },
    },
    paths: { skillsDir },
    handlers: {},
    tools: [],
  });

  await agent.reply("private-A", "whatsapp:sender-A");
  await agent.reply("private-B", "whatsapp:sender-B");
  assert.equal(payloads[1].messages.some(({ content }) => content === "private-A"), false);
});

test("passes approved images to vision models without retaining image data in history", async (t) => {
  const skillsDir = await mkdtemp(join(tmpdir(), "harvis-image-agent-skills-"));
  t.after(() => rm(skillsDir, { recursive: true, force: true }));
  const payloads = [];
  const responses = [
    {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "image-read",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"photo.png"}' },
          }],
        },
      }],
    },
    { choices: [{ message: { role: "assistant", content: "Veo una imagen." } }] },
    { choices: [{ message: { role: "assistant", content: "Sí, la recuerdo." } }] },
  ];
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    payloads.push(JSON.parse(request.body));
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  });
  const agent = new Agent({
    config: {
      name: "Harvis",
      skills: {},
      provider: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "vision-model",
        apiKey: "",
        temperature: 0,
        maxTokens: 128,
      },
    },
    paths: { skillsDir },
    handlers: {
      read_file: async () => ({
        type: "image",
        mimetype: "image/png",
        data: Buffer.from("image bytes").toString("base64"),
        text: "Imagen leída.",
      }),
    },
    tools: [{ type: "function", function: { name: "read_file" } }],
  });

  assert.equal(await agent.reply("Describe photo.png", "whatsapp:test", {
    requestApproval: async () => true,
  }), "Veo una imagen.");
  assert.ok(payloads[1].messages.some((message) =>
    message.role === "user" && Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image_url"),
  ));
  await agent.reply("¿La recuerdas?", "whatsapp:test");
  const serializedHistory = JSON.stringify(payloads[2].messages);
  assert.doesNotMatch(serializedHistory, /aW1hZ2UgYnl0ZXM=/);
  assert.match(serializedHistory, /La imagen se analizó/);
});
