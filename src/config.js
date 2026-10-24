import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const defaults = {
  name: "Harvis",
  setupComplete: false,
  provider: {
    name: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "",
    apiKey: "",
    temperature: 0.2,
    maxTokens: 1024,
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
  const root = env.HARVIS_HOME || (platform === "win32"
    ? join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "HarvisLite")
    : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "harvis-lite"));
  return {
    root,
    configFile: join(root, "config.json"),
    skillsDir: join(root, "skills"),
    channelsDir: join(root, "channels"),
    whatsappAuthDir: join(root, "whatsapp-auth"),
    serviceStateFile: join(root, "service.json"),
    serviceLockFile: join(root, "service.lock"),
    serviceLogFile: join(root, "service.log"),
  };
}

export function loadConfig(paths = getPaths(), { deferProviderUrlValidation = false } = {}) {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.skillsDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.channelsDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.whatsappAuthDir, { recursive: true, mode: 0o700 });
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
