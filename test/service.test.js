import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServiceControl } from "../src/service-control.js";
import { getPaths, loadConfig, saveConfig } from "../src/config.js";
import {
  buildWindowsAutostartScripts,
  getServiceStatus,
  startService,
  stopService,
} from "../src/service-manager.js";

test("terminal service control is loopback-only, authenticated, and does not approve pairings", async (t) => {
  let stopped = false;
  const service = await createServiceControl({
    token: "service-test-token",
    getStatus: () => ({ channels: [{ type: "whatsapp", status: "activo" }] }),
    onStop: () => { stopped = true; },
  });
  t.after(() => service.close());
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const auth = { Authorization: "Bearer service-test-token" };

  assert.equal((await fetch(`${baseUrl}/status`)).status, 401);
  const status = await fetch(`${baseUrl}/status`, { headers: auth });
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).channels, [
    { type: "whatsapp", status: "activo" },
  ]);

  const pairing = await fetch(`${baseUrl}/pairing/approve/123456`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(pairing.status, 404);

  const stop = await fetch(`${baseUrl}/stop`, { method: "POST", headers: auth });
  assert.equal(stop.status, 202);
  assert.equal(stopped, true);
});

test("service control does not expose a runtime pairing approval route", async (t) => {
  const service = await createServiceControl({
    token: "service-test-token",
    getStatus: () => ({}),
  });
  t.after(() => service.close());
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const pairing = await fetch(`${baseUrl}/pairing/approve/123456`, {
    method: "POST",
    headers: { Authorization: "Bearer service-test-token" },
  });
  assert.equal(pairing.status, 404);
});

test("Windows autostart registration is scoped to the current user and requests UAC only for task registration", () => {
  const scripts = buildWindowsAutostartScripts({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    workerPath: "C:\\Users\\Test User\\harvis\\src\\service-worker.js",
    homePath: "C:\\Users\\Test User\\AppData\\Roaming\\HarvisLite",
    userName: "MACHINE\\Test User",
  });

  assert.match(scripts.outer, /-Verb RunAs/);
  assert.match(
    scripts.outer,
    /Start-Process[^\r\n]*-ArgumentList[^\r\n]*-Verb RunAs/,
  );
  assert.match(scripts.taskScript, /-LogonType Interactive -RunLevel Limited/);
  assert.match(scripts.taskScript, /-AtLogOn -User \$identity/);
  assert.match(scripts.taskScript, /C:\\Users\\Test User\\AppData\\Roaming\\HarvisLite/);
  assert.doesNotMatch(scripts.taskScript, /-RunLevel Highest/);
});

test("background service starts and stops without registering system startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-service-"));
  const paths = getPaths({ HARVIS_HOME: root }, process.platform);
  t.after(async () => {
    try { await stopService(paths); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  const config = loadConfig(paths);
  config.setupComplete = true;
  saveConfig(config, paths);

  assert.match(await startService(paths, { registerAutostart: false }), /iniciado/);
  const status = await getServiceStatus(paths);
  assert.equal(status.running, true);
  assert.equal(status.ready, true);
  assert.deepEqual(status.channels, [
    { type: "console", enabled: true, status: "activo (panel)" },
  ]);
  assert.match(await stopService(paths), /detenido/);
  assert.equal((await getServiceStatus(paths)).running, false);

  assert.match(await startService(paths, { registerAutostart: false }), /iniciado/);
  assert.equal((await getServiceStatus(paths)).running, true);
  await stopService(paths);
  assert.equal((await getServiceStatus(paths)).running, false);
});
