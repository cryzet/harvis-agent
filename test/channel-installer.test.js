import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { installChannel } from "../src/channel-installer.js";
import { ChannelManager } from "../src/channels.js";
import { createChannel as createTelegramChannel } from "../src/channels/telegram.js";
import { createChannel as createDiscordChannel } from "../src/channels/discord.js";

test("installs the Baileys WhatsApp adapter on demand", async () => {
  const config = { channels: [{ type: "console", enabled: true }] };
  const installs = [];
  let saved = false;
  const result = await installChannel("whatsapp", {
    config,
    paths: { root: "C:\\profile", channelsDir: "C:\\profile\\channels" },
    install: async (packages, prefix) => installs.push({ packages, prefix }),
    save: () => { saved = true; },
  });

  assert.deepEqual(installs, [{
    packages: ["baileys@7.0.0-rc14", "qrcode-terminal@0.12.0"],
    prefix: "C:\\profile",
  }]);
  assert.deepEqual(config.channels[1], { type: "whatsapp", enabled: true });
  assert.equal(saved, true);
  assert.match(result, /Baileys.*WhatsApp/);
});

test("installs Telegram and Discord adapters without enabling incomplete credentials", async () => {
  const config = { channels: [{ type: "console", enabled: true }] };
  const installs = [];
  const save = () => {};
  const paths = { root: "C:\\profile" };

  await installChannel("telegram", {
    config,
    paths,
    install: async (packages) => installs.push(packages),
    save,
  });
  await installChannel("discord", {
    config,
    paths,
    install: async (packages) => installs.push(packages),
    save,
  });

  assert.deepEqual(installs, [["grammy@1.46.0"], ["discord.js@14.27.0"]]);
  assert.deepEqual(config.channels, [
    { type: "console", enabled: true },
    { type: "telegram", enabled: true },
    { type: "discord", enabled: true },
  ]);
});

test("explains why the OpenClaw host plugin cannot be installed as a Harvis adapter", async () => {
  await assert.rejects(
    installChannel("@openclaw/whatsapp", {
      config: { channels: [] },
      paths: {},
      save() {},
    }),
    /necesita el host OpenClaw/,
  );
});

test("installs external channel packages into the profile and enables the adapter", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-channel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const channelsDir = join(root, "channels");
  const config = { channels: [{ type: "console", enabled: true }] };
  const installs = [];
  const result = await installChannel("@sample/harvis-channel@1.2.3", {
    config,
    paths: { root, channelsDir },
    install: async (...args) => {
      installs.push(args);
      const packageRoot = join(args[1], "node_modules", "@sample", "harvis-channel");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        '{"name":"@sample/harvis-channel","type":"module","exports":"./index.js"}',
      );
      await writeFile(
        join(packageRoot, "index.js"),
        "export function createChannel() { return { start() {}, stop() {} }; }",
      );
    },
    save() {},
  });
  assert.deepEqual(installs, [
    [["@sample/harvis-channel@1.2.3"], join(channelsDir, "sample-harvis-channel")],
  ]);
  assert.deepEqual(config.channels[1], {
    type: "plugin-sample-harvis-channel",
    module: "@sample/harvis-channel",
    installDir: "sample-harvis-channel",
    enabled: true,
  });
  assert.match(result, /createChannel/);
});

test("loads external channel adapters and passes them a callable message handler", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-channel-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const channelsDir = join(root, "channels");
  const packageRoot = join(channelsDir, "adapter", "node_modules", "sample");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), '{"name":"sample","type":"commonjs"}');
  await writeFile(join(packageRoot, "index.js"), [
    "exports.lastMessage = null;",
    "exports.createChannel = () => ({",
    "  async start({ onMessage }) {",
    "    exports.lastMessage = await onMessage({ text: 'ping', sender: 'sample' });",
    "  },",
    "  async stop() {},",
    "});",
  ].join("\n"));
  const config = {
    channels: [{ type: "sample", module: "sample", installDir: "adapter", enabled: true }],
  };
  const manager = new ChannelManager(
    config,
    { root, channelsDir },
    async ({ text, sender }) => `${sender}:${text}`,
  );

  await manager.start();
  assert.deepEqual(manager.list(), [{ type: "sample", enabled: true, status: "activo" }]);
  assert.equal(
    createRequire(join(packageRoot, "package.json"))("./index.js").lastMessage,
    "sample:ping",
  );
  await manager.stop();
  assert.equal(manager.list()[0].status, "inactivo");
});

test("rejects Telegram and Discord channel startup without bot tokens", async () => {
  await assert.rejects(
    createTelegramChannel({ paths: { root: "C:\\profile" } }),
    /Falta el token del bot de Telegram/,
  );
  await assert.rejects(
    createDiscordChannel({ paths: { root: "C:\\profile" } }),
    /Falta el token del bot de Discord/,
  );
});

test("authorizes Telegram and Discord contacts in the local config", () => {
  const config = {
    channels: [
      { type: "telegram", enabled: true },
      { type: "discord", enabled: true },
    ],
  };
  let saves = 0;
  const manager = new ChannelManager(config, {}, async () => "", () => { saves += 1; });

  assert.match(manager.authorize("telegram", "123456"), /Contacto autorizado en telegram/);
  manager.authorize("discord", "654321");
  assert.deepEqual(config.channels.map(({ allowFrom }) => allowFrom), [["123456"], ["654321"]]);
  assert.equal(saves, 2);
});
