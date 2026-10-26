import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureClientProfileFilesSync } from "./client-access.js";

const defaults = {
  name: "Harvis",
  setupComplete: false,
  provider: {
    name: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "",
    apiKey: "",
    temperature: 0.2,
    maxTokens: 1000,
  },
  channels: [{ type: "console", enabled: true }],
  skills: {},
  mcp: { enabled: true, transport: "stdio" },
  web: {
    searchEnabled: true,
    searchProvider: "duckduckgo",
    searchApiKey: "",
    scrapeEnabled: true,
    maxResults: 5,
  },
};

export function getPaths(env = process.env, platform = process.platform) {
  const legacyRoot = platform === "win32"
    ? join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "HarvisLite")
    : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "harvis-lite");
  const documents = join(env.USERPROFILE || env.HOME || env.APPDATA || homedir(), "Documents");
  const legacyConfig = join(legacyRoot, "config.json");
  let agentName = "Harvis";
  if (existsSync(legacyConfig)) {
    try { agentName = JSON.parse(readFileSync(legacyConfig, "utf8")).name || agentName; } catch {}
  }
  const safeName = String(agentName).trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "").slice(0, 80) || "Harvis";
  let workRoot = env.HARVIS_HOME || join(documents, `${safeName}_WorkDir`);
  if (!env.HARVIS_HOME && existsSync(documents)) {
    const candidates = readdirSync(documents, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(documents, entry.name, "config", "config.json")))
      .map((entry) => join(documents, entry.name));
    const matching = candidates.filter((candidate) => {
      try {
        const name = JSON.parse(readFileSync(join(candidate, "config", "config.json"), "utf8")).name;
        return join(documents, `${sanitizeAgentName(name)}_WorkDir`) === candidate;
      } catch { return false; }
    });
    if (matching.length === 1) workRoot = matching[0];
    else if (matching.length > 1) {
      const expected = join(documents, `${safeName}_WorkDir`);
      if (matching.includes(expected)) workRoot = expected;
      else throw new Error("Hay varios perfiles Harvis en Documents. Define HARVIS_HOME con la carpeta del agente que quieres iniciar.");
    } else if (candidates.length === 1) workRoot = candidates[0];
    else if (candidates.length > 1) throw new Error("Hay varios perfiles Harvis en Documents. Define HARVIS_HOME con la carpeta del agente que quieres iniciar.");
  }
  const root = join(workRoot, "config");
  const filesDir = join(workRoot, "files");
  return {
    root,
    workRoot,
    filesDir,
    legacyRoot,
    configFile: join(root, "config.json"),
    skillsDir: join(root, "skills"),
    channelsDir: join(root, "channels"),
    whatsappAuthDir: join(root, "whatsapp-auth"),
    instructionsFile: join(root, "Instrucciones.txt"),
    ignoreFile: join(root, "Ignore.txt"),
    soulFile: join(root, "soul.md"),
    serviceStateFile: join(root, "service.json"),
    serviceLockFile: join(root, "service.lock"),
    serviceLogFile: join(root, "service.log"),
  };
}

export function loadConfig(paths = getPaths(), { deferProviderUrlValidation = false } = {}) {
  migrateLegacyProfile(paths);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.filesDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.skillsDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.channelsDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.whatsappAuthDir, { recursive: true, mode: 0o700 });
  ensureClientProfileFilesSync(paths);
  if (!existsSync(paths.soulFile)) {
    writeFileSync(paths.soulFile, "Eres un asistente personal local, útil, claro y prudente. Responde en el idioma del usuario.\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  if (!existsSync(paths.configFile)) saveConfig(defaults, paths);

  let stored;
  try {
    stored = JSON.parse(readFileSync(paths.configFile, "utf8"));
  } catch (error) {
    throw new Error(`No se pudo cargar ${paths.configFile}: ${error.message}`, {
      cause: error,
    });
  }
  const config = {
    ...defaults,
    ...stored,
    provider: { ...defaults.provider, ...stored.provider },
    channels: Array.isArray(stored.channels) ? stored.channels : defaults.channels,
    skills: stored.skills && typeof stored.skills === "object" ? stored.skills : {},
    mcp: { ...defaults.mcp, ...stored.mcp },
    web: { ...defaults.web, ...stored.web },
  };
  if (config.provider.maxTokens === 1024) config.provider.maxTokens = 1000;
  config.provider.baseUrl = process.env.OPENAI_BASE_URL || config.provider.baseUrl;
  config.provider.model = process.env.OPENAI_MODEL || config.provider.model;
  config.provider.apiKey = process.env.OPENAI_API_KEY || config.provider.apiKey;
  config.web.searchApiKey = process.env.HARVIS_BRAVE_SEARCH_API_KEY ||
    config.web.searchApiKey;
  for (const channel of config.channels) {
    if (channel.type === "telegram") {
      channel.token = process.env.HARVIS_TELEGRAM_BOT_TOKEN ||
        process.env.TELEGRAM_BOT_TOKEN || channel.token || "";
    }
    if (channel.type === "discord") {
      channel.token = process.env.HARVIS_DISCORD_BOT_TOKEN ||
        process.env.DISCORD_BOT_TOKEN || channel.token || "";
    }
  }
  validateConfig(config, { deferProviderUrlValidation });
  return config;
}

export function relocateProfileForName(paths, name) {
  const safeName = String(name || "Harvis").trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 80) || "Harvis";
  const expectedRoot = join(dirname(paths.workRoot), `${safeName}_WorkDir`);
  if (expectedRoot === paths.workRoot) return paths;
  const destination = getPaths({ ...process.env, HARVIS_HOME: expectedRoot });
  if (existsSync(destination.configFile)) {
    throw new Error(`Ya existe una carpeta de trabajo para "${safeName}" con otra configuración: ${expectedRoot}`);
  }
  mkdirSync(destination.root, { recursive: true, mode: 0o700 });
  mkdirSync(destination.filesDir, { recursive: true, mode: 0o700 });
  if (existsSync(paths.root)) copyMissing(paths.root, destination.root);
  if (existsSync(paths.filesDir)) copyMissing(paths.filesDir, destination.filesDir);
  Object.assign(paths, destination);
  return paths;
}

function copyMissing(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (!existsSync(to)) cpSync(from, to, { recursive: true, force: false });
    else if (entry.isDirectory()) copyMissing(from, to);
  }
}

function sanitizeAgentName(name) {
  return String(name || "Harvis").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "").slice(0, 80) || "Harvis";
}

function migrateLegacyProfile(paths) {
  if (paths.legacyRoot && paths.legacyRoot !== paths.root && existsSync(join(paths.legacyRoot, "config.json"))) {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(paths.legacyRoot, { withFileTypes: true })) {
      const source = join(paths.legacyRoot, entry.name);
      const destination = join(paths.root, entry.name);
      if (!existsSync(destination)) cpSync(source, destination, { recursive: true, force: false });
    }
  }
  if (paths.workRoot && paths.filesDir && existsSync(paths.workRoot)) {
    mkdirSync(paths.filesDir, { recursive: true, mode: 0o700 });
    const oldInbox = join(paths.workRoot, "WhatsApp-Inbox");
    const newInbox = join(paths.filesDir, "WhatsApp-Inbox");
    if (existsSync(oldInbox) && !existsSync(newInbox)) cpSync(oldInbox, newInbox, { recursive: true, force: false });
  }
  const previousWorkRoot = join(dirname(paths.workRoot), "Harvis_WorkDir");
  if (previousWorkRoot !== paths.workRoot && existsSync(previousWorkRoot) &&
      !existsSync(join(previousWorkRoot, "config", "config.json"))) {
    mkdirSync(paths.filesDir, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(previousWorkRoot, { withFileTypes: true })) {
      if (entry.name === "config" || entry.name === "files") continue;
      const source = join(previousWorkRoot, entry.name);
      const destination = join(paths.filesDir, entry.name);
      if (!existsSync(destination)) cpSync(source, destination, { recursive: true, force: false });
    }
  }
}

export function saveConfig(config, paths = getPaths()) {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const temporary = `${paths.configFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, paths.configFile);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `No se pudo guardar la configuración ni limpiar el archivo temporal ${temporary}.`,
      );
    }
    throw new Error(`No se pudo guardar la configuración: ${error.message}`, {
      cause: error,
    });
  }
}

function validateConfig(config, { deferProviderUrlValidation = false } = {}) {
  if (typeof config.name !== "string" || !config.name.trim()) {
    throw new Error("El nombre del agente debe ser texto no vacío.");
  }
  if (!Array.isArray(config.channels) ||
      !config.channels.some((channel) => channel.type === "console" && channel.enabled !== false)) {
    throw new Error("El canal de consola debe estar habilitado.");
  }
  if (typeof config.provider.model !== "string" ||
      typeof config.provider.apiKey !== "string") {
    throw new Error("provider.model y provider.apiKey deben ser valores de texto.");
  }
  if (!deferProviderUrlValidation) {
    try {
      const url = new URL(config.provider.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error("provider.baseUrl debe ser una URL válida HTTP o HTTPS.");
    }
  }
  if (!Number.isFinite(config.provider.temperature) ||
      config.provider.temperature < 0 || config.provider.temperature > 2) {
    throw new Error("provider.temperature debe estar entre 0 y 2.");
  }
  if (!["duckduckgo", "brave"].includes(config.web.searchProvider)) {
    throw new Error("web.searchProvider debe ser duckduckgo o brave.");
  }
  if (!Number.isInteger(config.web.maxResults) ||
      config.web.maxResults < 1 || config.web.maxResults > 10) {
    throw new Error("web.maxResults debe estar entre 1 y 10.");
  }
}
