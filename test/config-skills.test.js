import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPaths, loadConfig, saveConfig } from "../src/config.js";
import { installSkillPackage } from "../src/skill-installer.js";
import { createSkill, listSkills, setSkillEnabled, skillInstructions } from "../src/skills.js";

test("creates and toggles profile-local skills", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-skills-"));
  const paths = getPaths({ APPDATA: root }, "win32");
  const config = loadConfig(paths);
  t.after(() => rm(root, { recursive: true, force: true }));

  const created = createSkill({
    name: "summarizer",
    description: "Summarize content",
    instructions: "Use concise bullets.",
  }, paths, config);
  saveConfig(config, paths);

  assert.match(created, /creada y habilitada/);
  assert.deepEqual(listSkills(paths, config), [{ name: "summarizer", enabled: true }]);
  assert.match(skillInstructions(paths, config), /Use concise bullets/);
  setSkillEnabled("summarizer", false, paths, config, () => saveConfig(config, paths));
  assert.deepEqual(skillInstructions(paths, config), "");
  assert.match(await readFile(join(paths.skillsDir, "summarizer", "SKILL.md"), "utf8"), /name: summarizer/);
  assert.throws(
    () => createSkill({ name: "../bad", instructions: "no" }, paths, config),
    /nombre de la skill/,
  );
});

test("uses a new isolated profile directory for Harvis Lite", () => {
  const paths = getPaths({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "win32");
  assert.equal(paths.root, "C:\\Users\\test\\AppData\\Roaming\\HarvisLite");
  assert.equal(
    getPaths({ HARVIS_HOME: "D:\\HarvisProfile" }, "win32").root,
    "D:\\HarvisProfile",
  );
});

test("supports environment configuration for remote model providers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-provider-"));
  const paths = getPaths({ APPDATA: root }, "win32");
  loadConfig(paths);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig(paths);
  config.provider.baseUrl = "https://example.test/v1";
  config.provider.model = "cloud-model";
  saveConfig(config, paths);

  const oldBaseUrl = process.env.OPENAI_BASE_URL;
  const oldModel = process.env.OPENAI_MODEL;
  const oldApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = "https://env.example/v1";
  process.env.OPENAI_MODEL = "env-model";
  process.env.OPENAI_API_KEY = "test-only-key";
  t.after(() => {
    if (oldBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = oldBaseUrl;
    if (oldModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = oldModel;
    if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldApiKey;
  });
  const envConfig = loadConfig(paths);
  assert.equal(envConfig.provider.baseUrl, "https://env.example/v1");
  assert.equal(envConfig.provider.model, "env-model");
  assert.equal(envConfig.provider.apiKey, "test-only-key");
});

test("defers invalid provider URLs during startup so setup can repair them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-provider-setup-"));
  const paths = getPaths({ APPDATA: root }, "win32");
  const config = loadConfig(paths);
  t.after(() => rm(root, { recursive: true, force: true }));
  config.provider.baseUrl = "not a URL";
  saveConfig(config, paths);

  assert.throws(() => loadConfig(paths), /URL válida/);
  assert.equal(loadConfig(paths, { deferProviderUrlValidation: true }).provider.baseUrl, "not a URL");
});

test("installs a scoped npm skill with an exact version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harvis-skill-install-"));
  const paths = getPaths({ APPDATA: root }, "win32");
  const config = loadConfig(paths);
  await mkdir(paths.skillsDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  let saved = 0;
  let installedSpec;

  const result = await installSkillPackage("@sample/daily-skill@1.2.3", {
    paths,
    config,
    save: () => { saved += 1; },
    confirmInstall: async () => true,
    install: async (spec, staging) => {
      installedSpec = spec;
      const packageRoot = join(staging, "node_modules", "@sample", "daily-skill");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "SKILL.md"), "# Daily skill\nProvide a concise daily summary.");
      return "installation output";
    },
  });

  assert.equal(installedSpec, "@sample/daily-skill@1.2.3");
  assert.equal(config.skills["daily-skill"], true);
  assert.equal(saved, 1);
  assert.match(result, /daily-skill.*instalada y habilitada/);
  assert.match(
    await readFile(join(paths.skillsDir, "daily-skill", "SKILL.md"), "utf8"),
    /concise daily summary/,
  );
});
