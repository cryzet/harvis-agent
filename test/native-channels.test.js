import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createChannel as createWhatsAppChannel } from "../src/channels/whatsapp.js";
import { createChannel as createTelegramChannel } from "../src/channels/telegram.js";
import { createChannel as createDiscordChannel } from "../src/channels/discord.js";

test("WhatsApp QR is rendered in the terminal without logging its raw payload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-whatsapp-qr-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baileysDir = join(root, "node_modules", "baileys");
  const pinoDir = join(root, "node_modules", "pino");
  const qrDir = join(root, "node_modules", "qrcode-terminal");
  await mkdir(baileysDir, { recursive: true });
  await mkdir(pinoDir, { recursive: true });
  await mkdir(qrDir, { recursive: true });
  await writeFile(join(root, "package.json"), '{"private":true}');
  await writeFile(join(baileysDir, "package.json"), JSON.stringify({
    name: "baileys",
    type: "module",
    exports: "./index.js",
  }));
  await writeFile(join(baileysDir, "index.js"), [
    "import { EventEmitter } from 'node:events';",
    "export let lastSocket;",
    "export let lastOptions;",
    "export const useMultiFileAuthState = async () => ({ state: {}, saveCreds() {} });",
    "export default function makeWASocket(options) {",
    "  lastOptions = options;",
    "  lastSocket = { ev: new EventEmitter(), sendMessage() {}, end() {} };",
    "  return lastSocket;",
    "}",
  ].join("\n"));
  await writeFile(join(pinoDir, "package.json"), '{"name":"pino","main":"index.js"}');
  await writeFile(join(pinoDir, "index.js"), [
    "module.exports = ({ level }) => ({ level, child() { return this; } });",
  ].join("\n"));
  await writeFile(join(qrDir, "package.json"), '{"name":"qrcode-terminal","main":"index.js"}');
  await writeFile(join(qrDir, "index.js"), [
    "module.exports = {",
    "  error: 'L',",
    "  generate(input, options, callback) {",
    "    if (this.error !== 'L') throw new Error('receiver was lost');",
    "    if (input === 'sensitive-qr-payload') throw new Error('render failed');",
    "    if (callback) callback(`QR_TEXT:${input}`);",
    "    else console.log('QR_RENDERED', options.small);",
    "  },",
    "};",
  ].join("\n"));

  const adapterConfig = {
    paths: { root, whatsappAuthDir: join(root, "auth") },
  };
  const adapter = await createWhatsAppChannel(adapterConfig);
  await adapter.start({ onMessage() {} });
  const baileys = await import(pathToFileURL(join(baileysDir, "index.js")).href);
  assert.equal(baileys.lastOptions.logger.level, "silent");
  const readiness = adapter.waitUntilReady();
  const output = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => output.push(args.join(" "));
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    baileys.lastSocket.ev.emit("connection.update", { qr: "normal-qr" });
    await readiness;
    assert.ok(output.includes("QR_RENDERED true"));

    output.length = 0;
    warnings.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    baileys.lastSocket.ev.emit("connection.update", { qr: "sensitive-qr-payload" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /No se mostrará el código por seguridad/);
    assert.doesNotMatch(warnings[0], /sensitive-qr-payload/);
    const connected = adapter.waitUntilConnected(1000);
    baileys.lastSocket.ev.emit("connection.update", { connection: "open" });
    await connected;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    await adapter.stop();
  }
});

test("WhatsApp routes admin and client roles, ignores configured numbers, and rejects client attachments before download", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-whatsapp-pairing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baileysDir = join(root, "node_modules", "baileys");
  const pinoDir = join(root, "node_modules", "pino");
  await mkdir(baileysDir, { recursive: true });
  await mkdir(pinoDir, { recursive: true });
  await writeFile(join(root, "package.json"), '{"private":true}');
  await writeFile(join(baileysDir, "package.json"), JSON.stringify({
    name: "baileys",
    type: "module",
    exports: "./index.js",
  }));
  await writeFile(join(baileysDir, "index.js"), [
    "import { EventEmitter } from 'node:events';",
    "export let lastSocket;",
    "export const useMultiFileAuthState = async () => ({ state: {}, saveCreds() {} });",
    "export let downloadCalls = 0;",
    "export const downloadMediaMessage = async () => { downloadCalls += 1; return Buffer.from('received attachment'); };",
    "export default function makeWASocket() {",
    "  lastSocket = { ev: new EventEmitter(), sent: [], presence: [], sendPresenceUpdate: async (status, jid) => lastSocket.presence.push({ status, jid }), sendMessage: async (jid, message) => lastSocket.sent.push({ jid, ...message }), end() {} };",
    "  return lastSocket;",
    "}",
  ].join("\n"));
  await writeFile(join(pinoDir, "package.json"), '{"name":"pino","main":"index.js"}');
  await writeFile(join(pinoDir, "index.js"), "module.exports = () => ({ level: 'silent' });");

  const received = [];
  const agentName = `Harvis-test-${Date.now()}`;
  const workDir = join(homedir(), "Documents", `${agentName}_WorkDir`);
  const ignoreFile = join(root, "Ignore.txt");
  const instructionsFile = join(root, "Instrucciones.txt");
  await writeFile(ignoreFile, "+447700900123\n");
  await writeFile(instructionsFile, "Horario de atención: lunes a viernes.");
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const adapter = await createWhatsAppChannel({
    name: agentName,
    type: "whatsapp",
    allowFrom: ["+15551234567"],
    adminNumber: "+15551234567",
    paths: {
      root,
      whatsappAuthDir: join(root, "auth"),
      ignoreFile,
      instructionsFile,
    },
  });
  await adapter.start({
    onMessage: async (message) => {
      received.push(message);
      if (received.length === 1) {
        assert.deepEqual(baileys.lastSocket.presence, [
          { status: "composing", jid: "123456789012345@lid" },
        ]);
      }
      return "Harvis reply";
    },
  });
  const baileys = await import(pathToFileURL(join(baileysDir, "index.js")).href);
  try {
    baileys.lastSocket.ev.emit("connection.update", { connection: "open" });
    baileys.lastSocket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          remoteJid: "123456789012345@lid",
          remoteJidAlt: "15551234567@s.whatsapp.net",
          fromMe: false,
        },
        message: { conversation: "Hola" },
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.length, 1);
    assert.equal(received[0].sender, "123456789012345@lid");
    assert.equal(received[0].role, "admin");
    assert.equal(received[0].phoneNumber, "+15551234567");
    assert.equal(received[0].requestApproval, undefined);
    assert.equal(baileys.lastSocket.sent.length, 1);
    assert.equal(baileys.lastSocket.sent[0].text, "Harvis reply");
    assert.deepEqual(baileys.lastSocket.presence, [
      { status: "composing", jid: "123456789012345@lid" },
      { status: "paused", jid: "123456789012345@lid" },
    ]);

    await received[0].sendFile({
      buffer: Buffer.from("outgoing"),
      fileName: "notes.txt",
      mimetype: "text/plain",
    });
    assert.equal(baileys.lastSocket.sent.at(-1).document.toString(), "outgoing");

    baileys.lastSocket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          remoteJid: "123456789012345@lid",
          remoteJidAlt: "15551234567@s.whatsapp.net",
          fromMe: false,
        },
        message: {
          documentMessage: {
            fileName: "notes.txt",
            mimetype: "text/plain",
            fileLength: "19",
          },
        },
      }],
    });

    await waitFor(() => received.length === 2);
    assert.equal(received.length, 2);
    assert.equal(received[1].role, "admin");
    assert.match(received[1].text, /Archivo recibido y guardado/);
    assert.match(received[1].attachment.path, new RegExp(`${agentName}_WorkDir`));
    assert.equal(await readFile(received[1].attachment.path, "utf8"), "received attachment");
    assert.equal(baileys.downloadCalls, 1);

    baileys.lastSocket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          remoteJid: "14155552672@s.whatsapp.net",
          fromMe: false,
        },
        message: { conversation: "¿Cuál es el horario?" },
      }],
    });
    await waitFor(() => received.length === 3);
    assert.equal(received[2].role, "client");
    assert.equal(received[2].phoneNumber, "+14155552672");

    baileys.lastSocket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          remoteJid: "14155552672@s.whatsapp.net",
          fromMe: false,
        },
        message: {
          documentMessage: {
            fileName: "client.txt",
            mimetype: "text/plain",
            fileLength: "19",
          },
        },
      }],
    });
    await waitFor(() => baileys.lastSocket.sent.at(-1)?.text.includes("no recibo archivos de clientes"));
    assert.equal(received.length, 3);
    assert.equal(baileys.downloadCalls, 1);

    const sentBeforeIgnoredMessage = baileys.lastSocket.sent.length;
    baileys.lastSocket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { remoteJid: "447700900123@s.whatsapp.net", fromMe: false },
        message: { conversation: "Ignorarme" },
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.length, 3);
    assert.equal(baileys.lastSocket.sent.length, sentBeforeIgnoredMessage);
  } finally {
    await adapter.stop();
  }

  async function waitFor(predicate, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for WhatsApp test event.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
});

test("Telegram adapter forwards only allowlisted messages and replies through grammY", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-telegram-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, "node_modules", "grammy");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), '{"name":"grammy","type":"module","exports":"./index.js"}');
  await writeFile(join(packageDir, "index.js"), [
    "export let lastBot;",
    "export class Bot {",
    "  constructor(token) { this.token = token; this.api = { getMe: async () => ({ username: 'test' }) }; lastBot = this; }",
    "  on(_event, callback) { this.handler = callback; }",
    "  async start() {}",
    "  async stop() {}",
    "}",
  ].join("\n"));

  const adapter = await createTelegramChannel({
    token: "telegram-test-token",
    allowFrom: ["123"],
    paths: { root },
  });
  let received;
  await adapter.start({
    onMessage: async (message) => {
      received = message;
      return "Harvis reply";
    },
  });
  const grammy = await import(pathToFileURL(join(packageDir, "index.js")).href);
  const replies = [];
  await grammy.lastBot.handler({
    message: { text: "hello", from: { id: 123, is_bot: false }, chat: { id: 456 } },
    reply: async (text) => replies.push(text),
  });
  assert.equal(received.sender, "telegram:456:123");
  assert.equal(received.text, "hello");
  assert.deepEqual(replies, ["Harvis reply"]);
  await adapter.stop();
});

test("Discord adapter connects with a bot token and routes authorized messages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-discord-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, "node_modules", "discord.js");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), '{"name":"discord.js","type":"module","exports":"./index.js"}');
  await writeFile(join(packageDir, "index.js"), [
    "export const GatewayIntentBits = { Guilds: 1, GuildMessages: 2, DirectMessages: 4, MessageContent: 8 };",
    "export const Partials = { Channel: 1 };",
    "export let lastClient;",
    "export class Client {",
    "  constructor(options) { this.options = options; this.user = { tag: 'Harvis#0001' }; this.listeners = {}; lastClient = this; }",
    "  on(event, callback) { this.listeners[event] = callback; }",
    "  async login(token) { this.token = token; }",
    "  destroy() { this.destroyed = true; }",
    "}",
  ].join("\n"));

  const adapter = await createDiscordChannel({
    token: "discord-test-token",
    allowFrom: ["789"],
    paths: { root },
  });
  let received;
  await adapter.start({
    onMessage: async (message) => {
      received = message;
      return "Harvis reply";
    },
  });
  const discord = await import(pathToFileURL(join(packageDir, "index.js")).href);
  const replies = [];
  await discord.lastClient.listeners.messageCreate({
    author: { id: "789", bot: false },
    content: "hello",
    channelId: "321",
    reply: async (text) => replies.push(text),
  });
  assert.equal(received.sender, "discord:321:789");
  assert.equal(received.text, "hello");
  assert.deepEqual(replies, ["Harvis reply"]);
  await adapter.stop();
  assert.equal(discord.lastClient.destroyed, true);
});
