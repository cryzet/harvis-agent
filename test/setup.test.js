import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPaths, loadConfig } from "../src/config.js";
import { checkSetup, runStartupSetup } from "../src/setup.js";

test("detects an enabled WhatsApp channel without Baileys and an unset model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-setup-check-"));
  const paths = getPaths({ APPDATA: root }, "win32");
  const config = loadConfig(paths);
  t.after(() => rm(root, { recursive: true, force: true }));
  config.channels.push({ type: "whatsapp", enabled: true });

  const issues = checkSetup(config, paths);
  assert.equal(issues.some((issue) => issue.includes("No hay un modelo configurado")), true);
  assert.equal(issues.some((issue) => issue.includes("Falta la dependencia del canal whatsapp")), true);
  assert.equal(issues.some((issue) => issue.includes("Require stack") || issue.includes(paths.root)), false);
});

test("reports missing Telegram and Discord bot tokens without exposing profile details", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-setup-channels-"));
  const paths = getPaths({ APPDATA: root }, "win32");
  const config = loadConfig(paths);
  t.after(() => rm(root, { recursive: true, force: true }));
  config.provider.model = "test-model";
  config.channels.push(
    { type: "telegram", enabled: true },
    { type: "discord", enabled: true },
  );

  const issues = checkSetup(config, paths);
  assert.equal(issues.some((issue) => issue.includes("Telegram no tiene token de bot")), true);
  assert.equal(issues.some((issue) => issue.includes("Discord no tiene token de bot")), true);
  assert.equal(issues.some((issue) => issue.includes(root)), false);
});

test("runs first-time onboarding before applying the startup repair menu", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-first-run-"));
  const paths = getPaths({ APPDATA: root }, "win32");
  const config = loadConfig(paths);
  t.after(() => rm(root, { recursive: true, force: true }));
  let onboardingCalls = 0;
  let configureCalls = 0;

  const result = await runStartupSetup({
    config,
    paths,
    interactive: true,
    terminal: {
      async onboard() {
        onboardingCalls += 1;
        config.setupComplete = true;
        config.provider.model = "configured-model";
        return "setup";
      },
      async configure() {
        configureCalls += 1;
      },
    },
  });

  assert.equal(onboardingCalls, 1);
  assert.equal(configureCalls, 0);
  assert.deepEqual(result, []);
});

test("runs configure at startup and rechecks repaired configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-setup-flow-"));
  const paths = getPaths({ APPDATA: root }, "win32");
  const config = loadConfig(paths);
  t.after(() => rm(root, { recursive: true, force: true }));
  config.setupComplete = true;
  config.provider.baseUrl = "invalid";
  config.provider.model = "";
  let configured = false;

  const remaining = await runStartupSetup({
    config,
    paths,
    interactive: true,
    terminal: {
      async configure(args) {
        configured = true;
        assert.deepEqual(args, []);
        config.provider.baseUrl = "http://127.0.0.1:1234/v1";
        config.provider.model = "local-model";
        return "Configuración guardada.";
      },
    },
  });

  assert.equal(configured, true);
  assert.deepEqual(remaining, []);
});
