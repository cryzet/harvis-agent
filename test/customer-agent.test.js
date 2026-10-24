import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCustomerAgent } from "../src/customer-agent.js";

test("customers receive the configured instructions with no tools or cross-customer history", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "harvis-customer-agent-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const instructionsFile = join(profile, "Instrucciones.txt");
  await writeFile(instructionsFile, "Atendemos de lunes a viernes de 9 a 5.");
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    const payload = JSON.parse(request.body);
    payloads.push(payload);
    const lastUser = payload.messages.findLast(({ role }) => role === "user");
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: `Respuesta a ${lastUser.content}` } }],
    }), { status: 200 });
  });
  const customerAgent = createCustomerAgent({
    config: {
      name: "Harvis",
      provider: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-model",
        apiKey: "",
        temperature: 0,
        maxTokens: 1000,
      },
    },
    paths: { instructionsFile },
  });

  await customerAgent.reply("¿Cuál es el horario?", "+14155552671");
  await customerAgent.reply("¿Dónde están?", "+14155552672");
  assert.equal(payloads[0].tools, undefined);
  assert.match(payloads[0].messages[0].content, /Atendemos de lunes a viernes/);
  assert.match(payloads[0].messages[0].content, /No uses conocimiento general/);
  assert.equal(payloads[1].messages.some(({ content }) =>
    typeof content === "string" && content.includes("¿Cuál es el horario?")), false);
});

test("customers receive a generic fallback when instructions are empty", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "harvis-customer-empty-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const instructionsFile = join(profile, "Instrucciones.txt");
  await writeFile(instructionsFile, "  \n");
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("No debe llamarse al proveedor sin instrucciones.");
  });
  const customerAgent = createCustomerAgent({
    config: { name: "Harvis" },
    paths: { instructionsFile },
  });

  assert.match(
    await customerAgent.reply("Hola", "+14155552671"),
    /No tengo esa información disponible/,
  );
});

test("admin can update instructions immediately for future customer messages", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "harvis-customer-live-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const instructionsFile = join(profile, "Instrucciones.txt");
  await writeFile(instructionsFile, "Horario anterior.");
  const prompts = [];
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    const messages = JSON.parse(request.body).messages;
    prompts.push(messages[0].content);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Respuesta" } }],
    }), { status: 200 });
  });
  const customerAgent = createCustomerAgent({
    config: {
      name: "Harvis",
      provider: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-model",
        apiKey: "",
        temperature: 0,
        maxTokens: 1000,
      },
    },
    paths: { instructionsFile },
  });

  await customerAgent.reply("Horario", "+14155552671");
  await writeFile(instructionsFile, "Horario nuevo.");
  await customerAgent.reply("Horario", "+14155552671");
  assert.match(prompts[0], /Horario anterior/);
  assert.match(prompts[1], /Horario nuevo/);
});
