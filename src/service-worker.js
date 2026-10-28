import { randomBytes } from "node:crypto";
import { Console } from "node:console";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { Agent } from "./agent.js";
import { createCustomerAgent } from "./customer-agent.js";
import { ChannelManager } from "./channels.js";
import { getPaths, loadConfig, saveConfig } from "./config.js";
import { createServiceControl } from "./service-control.js";
import { createToolHandlers, toolDefinitions } from "./runtime-tools.js";
import { pdfToolDefinition } from "./file-tools.js";
import { scrapeWebPage, searchWeb, webToolDefinitions } from "./web-tools.js";

const homeArgument = process.argv.indexOf("--home");
if (homeArgument !== -1 && process.argv[homeArgument + 1]) {
  process.env.HARVIS_HOME = process.argv[homeArgument + 1];
}
const paths = getPaths();
let channelManager;
let serviceControl;
let agent;
let customerAgent;
let stopping;
let lockFd;
let logStream;
let ready = false;

export async function runServiceWorker() {
  if (!existsSync(paths.configFile) && !existsSync(join(paths.legacyRoot, "config.json"))) {
    throw new Error("La configuración inicial no existe; inicia Harvis desde npm start para elegir el nombre del agente.");
  }
  await configureLogging();
  acquireLock();
  const config = loadConfig(paths, { deferProviderUrlValidation: true });
  if (!config.setupComplete) {
    throw new Error("La configuración inicial no está completa; inicia Harvis desde la consola.");
  }
  const controlToken = randomBytes(32).toString("hex");
  serviceControl = await createServiceControl({
    token: controlToken,
    getStatus: () => ({
      ready,
      channels: channelManager?.list() ?? [],
    }),
    onClearMemory: () => [agent?.clearMemory(), customerAgent?.clearMemory()]
      .filter(Boolean).join(" "),
  });
  serviceControl.onStop?.(() => void shutdown("control"));
  writeServiceState({
    port: serviceControl.port,
    token: controlToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const save = () => saveConfig(config, paths);
  const handlers = createToolHandlers({
    config,
    paths,
    save,
    confirmInstall: async () => {
      throw new Error("Las instalaciones npm requieren la consola interactiva de Harvis.");
    },
    getChannelStatuses: () => channelManager?.list() ?? [],
    searchWeb: (query, count) => searchWeb(query, config, { count }),
    scrapeWebPage: (url) => scrapeWebPage(url),
    onPdfEnabledChange: (enabled) => {
      agent.tools = agent.tools.filter(({ function: { name } }) => name !== "create_pdf");
      if (enabled) agent.tools.push(pdfToolDefinition);
      return "service";
    },
  });
  const tools = [
    ...toolDefinitions.filter(({ function: { name } }) =>
      !webToolDefinitions.some((webTool) => webTool.function.name === name)),
    ...(config.web.searchEnabled
      ? [webToolDefinitions.find(({ function: { name } }) => name === "web_search")]
      : []),
    ...(config.web.scrapeEnabled
      ? [webToolDefinitions.find(({ function: { name } }) => name === "web_scrape")]
      : []),
    ...(config.pdf?.enabled ? [pdfToolDefinition] : []),
  ];
  agent = new Agent({ config, paths, handlers, tools });
  customerAgent = createCustomerAgent({ config, paths });
  channelManager = new ChannelManager(
    config,
    paths,
    async ({ text, sender, role, phoneNumber, sendFile, sendContactMessage, sendWhatsAppAudio, audioRequested, voiceAudioEnabled, channelType, attachment, replyFormat }) => {
      if (role === "client" && channelType === "whatsapp") {
        return customerAgent.reply(text, phoneNumber ?? sender, {
          sendContactMessage, replyFormat, sendWhatsAppAudio, audioRequested, voiceAudioEnabled,
        });
      }
      if (role !== "admin") {
        throw new Error("El remitente no tiene un rol autorizado para este canal.");
      }
      return agent.reply(text, `${channelType ?? "channel"}:${sender}`, {
        role: "admin",
        ...(channelType ? { channelType } : {}),
        ...(replyFormat ? { replyFormat } : {}),
        ...(audioRequested ? { audioRequested } : {}),
        ...(voiceAudioEnabled ? { voiceAudioEnabled } : {}),
        ...(attachment ? { attachment } : {}),
        ...(sendFile ? { sendFile } : {}),
        ...(sendContactMessage ? { sendContactMessage } : {}),
        ...(sendWhatsAppAudio ? { sendWhatsAppAudio } : {}),
      });
    },
    save,
  );
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await channelManager.start();
  ready = true;
  console.info(`Servicio Harvis activo. Canales: ${
    channelManager.list()
      .filter(({ type, enabled }) => type !== "console" && enabled)
      .map(({ type, status }) => `${type} (${status})`)
      .join(", ") || "ninguno"
  }`);
}

async function shutdown(reason) {
  if (stopping) return stopping;
  stopping = (async () => {
    console.info(`Cerrando servicio Harvis (${reason}).`);
    const results = await Promise.allSettled([
      channelManager?.stop(),
      serviceControl?.close(),
    ].filter(Boolean));
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(`Error al cerrar el servicio: ${result.reason.message}`);
        process.exitCode = 1;
      }
    }
    try {
      if (existsSync(paths.serviceStateFile)) unlinkSync(paths.serviceStateFile);
    } catch (error) {
      console.error(`No se pudo limpiar el estado del servicio: ${error.message}`);
      process.exitCode = 1;
    }
    await closeLogging();
    try {
      if (existsSync(paths.serviceLockFile)) unlinkSync(paths.serviceLockFile);
    } catch (error) {
      process.stderr.write(`No se pudo limpiar el bloqueo del servicio: ${error.message}\n`);
      process.exitCode = 1;
    }
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch {}
      lockFd = undefined;
    }
  })();
  return stopping;
}

async function configureLogging() {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  logStream = createWriteStream(paths.serviceLogFile, {
    flags: "a",
    mode: 0o600,
  });
  await new Promise((resolve, reject) => {
    logStream.once("open", resolve);
    logStream.once("error", reject);
  });
  globalThis.console = new Console({ stdout: logStream, stderr: logStream });
}

function closeLogging() {
  if (!logStream || logStream.closed) return Promise.resolve();
  return new Promise((resolve) => logStream.end(resolve));
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lockFd = openSync(paths.serviceLockFile, "wx", 0o600);
      writeFileSync(lockFd, `${process.pid}\n`);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previousPid = Number(readFileSync(paths.serviceLockFile, "utf8").trim());
      if (Number.isInteger(previousPid) && processExists(previousPid)) {
        throw new Error(`El servicio Harvis ya está iniciándose (PID ${previousPid}).`);
      }
      unlinkSync(paths.serviceLockFile);
    }
  }
  throw new Error("No se pudo adquirir el bloqueo exclusivo del servicio Harvis.");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function writeServiceState(state) {
  const temporary = `${paths.serviceStateFile}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
  try {
    if (existsSync(paths.serviceStateFile)) unlinkSync(paths.serviceStateFile);
    renameSync(temporary, paths.serviceStateFile);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runServiceWorker().catch((error) => {
    console.error(`No se pudo iniciar el servicio Harvis: ${error.message}`);
    void closeLogging();
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch {}
      try { unlinkSync(paths.serviceLockFile); } catch {}
    } 
    process.exitCode = 1;
  });
}
