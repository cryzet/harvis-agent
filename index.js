import { Agent } from "./src/agent.js";
import { installChannel as installChannelPackage } from "./src/channel-installer.js";
import { InteractiveConsole } from "./src/console.js";
import { getPaths, loadConfig, saveConfig } from "./src/config.js";
import { createToolHandlers, toolDefinitions } from "./src/runtime-tools.js";
import { createSkill, listSkills, setSkillEnabled } from "./src/skills.js";
import {
  getServiceStatus,
  startService,
  stopService,
} from "./src/service-manager.js";
import { runStartupSetup } from "./src/setup.js";
import { installSkillPackage } from "./src/skill-installer.js";
import { getAvailableModels as fetchAvailableModels } from "./src/provider-models.js";
import { scrapeWebPage, searchWeb, webToolDefinitions } from "./src/web-tools.js";
import { ChannelManager } from "./src/channels.js";
import { normalizeInternationalPhoneNumber } from "./src/phone-number.js";
import { createCustomerAgent } from "./src/customer-agent.js";
import {
  changeIgnoredNumber,
  readCustomerInstructions,
  readIgnoredNumbers,
  updateCustomerInstructions,
  getConfiguredAdminNumbers,
} from "./src/client-access.js";

const paths = getPaths();
let config = loadConfig(paths, { deferProviderUrlValidation: true });
let agent;
let stopping = false;
const terminal = new InteractiveConsole({
  config,
  save: () => saveConfig(config, paths),
  handlers: {
    reply: (text) => agent.reply(text, "console", {
      role: "admin",
    }),
    status: () => status(),
    models: () => listModels(),
    channels: () => formatChannels(),
    skills: () => formatSkills(),
    restart: () => restart(),
    startService: () => startPersistentService(),
    stopService: () => stopService(paths),
    setChannel: (name, enabled) => setChannel(name, enabled),
    authorizeChannel: (type, senderId) => authorizeChannel(type, senderId),
    linkWhatsApp: () => linkWhatsApp(),
    configureWhatsAppNumber: (number) => configureWhatsAppNumber(number),
    setupWhatsApp: () => setupWhatsApp(),
    providerModels: () => fetchAvailableModels({
      ...config.provider,
      providerName: config.provider.name,
    }),
    setSkill: (name, enabled) => setSkill(name, enabled),
    createSkill: (args) => createNewSkill(args),
    installSkill: (name) => installSkill(name),
    installChannel: (name) => installChannel(name),
    readInstructions: () => readCustomerInstructions(paths),
    writeInstructions: (content) => updateCustomerInstructions(paths, content),
    ignoredNumbers: () => readIgnoredNumbers(paths),
    changeIgnoredNumber: (number, action) =>
      changeIgnoredNumber(paths, number, action, getConfiguredAdminNumbers(config)),
  },
});

await terminal.start({ showPrompt: false, showBanner: false });
await runStartupSetup({
  terminal,
  config,
  paths,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
});
terminal.clearScreen();
await startRuntime();
terminal.printBanner();
console.info("INFO: Usa /help para ver los comandos disponibles.");
terminal.prompt();
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

async function startRuntime() {
  config = loadConfig(paths, { deferProviderUrlValidation: true });
  terminal.config = config;
  const handlers = createToolHandlers({
    config,
    paths,
    save: () => saveConfig(config, paths),
    confirmInstall: (packageName, purpose) =>
      terminal.confirmInstall(packageName, purpose),
    installChannel: (name) => installChannel(name),
    getChannelStatuses: async () => (await getServiceStatus(paths)).channels ?? [],
    searchWeb: (query, count) => searchWeb(query, config, { count }),
    scrapeWebPage: (url) => scrapeWebPage(url),
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
  ];
  agent = new Agent({ config, paths, handlers, tools });
  if (config.setupComplete) {
    console.info(await startPersistentService());
  }
}

async function startPersistentService() {
  try {
    return await startService(paths);
  } catch (error) {
    if (error.code !== "HARVIS_AUTOSTART_FAILED") throw error;
    console.error(`Inicio automático no disponible: ${error.message}`);
    const started = await startService(paths, { registerAutostart: false });
    return `${started} El inicio automático quedó deshabilitado; usa /start tras autorizar la tarea.`;
  }
}

async function restart() {
  await stopService(paths);
  return startService(paths, { registerAutostart: false });
}

async function setChannel(name, enabled) {
  const canonical = name;
  const channel = config.channels.find(({ type }) => type === canonical);
  if (!channel) {
    if (canonical === "whatsapp") {
      throw new Error('WhatsApp aún no está instalado. Usa /configure channel install whatsapp.');
    }
    throw new Error(`El canal "${canonical}" no está configurado.`);
  }
  if (canonical === "console" && !enabled) {
    throw new Error("El canal de consola no se puede deshabilitar.");
  }
  const serviceWasRunning = (await getServiceStatus(paths)).running;
  channel.enabled = enabled;
  saveConfig(config, paths);
  if (serviceWasRunning) await restart();
  return `Canal "${canonical}" ${enabled ? "habilitado" : "deshabilitado"}${serviceWasRunning ? " y aplicado" : ""}.`;
}

function authorizeChannel(type, senderId) {
  const channel = config.channels.find((entry) => entry.type === type);
  if (!channel) throw new Error(`El canal "${type}" no está instalado.`);
  const id = String(senderId).trim();
  if (!id) throw new Error("El identificador del contacto no puede estar vacío.");
  if (type === "whatsapp") {
    const number = normalizeInternationalPhoneNumber(id);
    channel.adminNumber = number;
    channel.allowFrom = [number];
    saveConfig(config, paths);
    return `Número administrador de WhatsApp configurado: ${number}.`;
  }
  channel.allowFrom ??= [];
  if (!channel.allowFrom.includes(id)) channel.allowFrom.push(id);
  saveConfig(config, paths);
  return `Contacto autorizado en ${type}: ${id}.`;
}

function setSkill(name, enabled) {
  return setSkillEnabled(name, enabled, paths, config, () => saveConfig(config, paths));
}

function createNewSkill(args) {
  const result = createSkill(args, paths, config);
  saveConfig(config, paths);
  return `${result} Usa /restart para cargarla en el prompt.`;
}

async function installSkill(name) {
  return installSkillPackage(name, {
    paths,
    config,
    save: () => saveConfig(config, paths),
    confirmInstall: (packageName) => terminal.confirmInstall(packageName, "skill"),
  });
}

async function installChannel(name) {
  const packageName = ["whatsapp", "wa"].includes(name.trim().toLowerCase())
    ? "whatsapp"
    : name;
  const result = await installChannelPackage(packageName, {
    config,
    paths,
    save: () => saveConfig(config, paths),
  });
  if (packageName === "whatsapp") {
    await configureWhatsAppNumber();
    const linkNow = (await terminal.ask("¿Vincular WhatsApp ahora con un QR? [S/n]: "))
      .trim().toLowerCase();
    if (!["n", "no"].includes(linkNow)) {
      return `${result}\n${await linkWhatsApp()}`;
    }
  }
  if (config.setupComplete && (await getServiceStatus(paths)).running) {
    await restart();
  }
  return result;
}

async function configureWhatsAppNumber(input = "") {
  const entry = config.channels.find(({ type }) => type === "whatsapp");
  if (!entry) throw new Error("Instala primero el canal WhatsApp.");
  const currentNumber = (entry.allowFrom ?? []).find((number) =>
    String(number).startsWith("+")) ?? "";
  let value = String(input).trim();
  while (!value) {
    value = (await terminal.ask(
      `Número desde el que escribirás a Harvis, en formato internacional (ej. +14155552671)${currentNumber ? ` [${currentNumber}]` : ""}: `,
    )).trim();
    if (!value && currentNumber) value = currentNumber;
  }
  const number = normalizeInternationalPhoneNumber(value);
  entry.allowFrom = [number];
  entry.adminNumber = number;
  entry.enabled = true;
  saveConfig(config, paths);
  const applied = (await getServiceStatus(paths)).running;
  if (applied) await restart();
  return `Número autorizado para WhatsApp: ${number}.${applied ? " Cambios aplicados." : ""}`;
}

async function setupWhatsApp() {
  const result = await configureWhatsAppNumber();
  const linkNow = (await terminal.ask("¿Vincular WhatsApp ahora con un QR? [S/n]: "))
    .trim().toLowerCase();
  if (["n", "no"].includes(linkNow)) return result;
  return `${result}\n${await linkWhatsApp()}`;
}

async function linkWhatsApp() {
  const channel = config.channels.find(({ type }) => type === "whatsapp");
  if (!channel?.enabled) {
    throw new Error("Instala y habilita WhatsApp antes de solicitar un QR.");
  }
  if (!getConfiguredAdminNumbers(channel).length) {
    throw new Error("Configura primero el número autorizado: /configure channel whatsapp number <+código-país-número>.");
  }
  const serviceWasRunning = config.setupComplete &&
    (await getServiceStatus(paths)).running;
  if (serviceWasRunning) await stopService(paths);
  const customerAgent = createCustomerAgent({ config, paths });
  const manager = new ChannelManager(
    config,
    paths,
    async ({ text, sender, role, phoneNumber, sendFile, channelType }) => {
      if (role === "client" && channelType === "whatsapp") {
        return customerAgent.reply(text, phoneNumber ?? sender);
      }
      if (role !== "admin") throw new Error("El remitente no tiene un rol autorizado para este canal.");
      return agent
        ? agent.reply(text, `whatsapp:${sender}`, {
          role: "admin",
          ...(sendFile ? { sendFile } : {}),
        })
        : "Harvis está terminando la configuración inicial.";
    },
    () => saveConfig(config, paths),
  );
  try {
    await manager.start({ types: ["whatsapp"] });
    const status = manager.list().find(({ type }) => type === "whatsapp")?.status;
    if (status?.startsWith("error:")) {
      throw new Error(`No se pudo iniciar el canal WhatsApp: ${status.slice(7)}`);
    }
    const choice = (await terminal.ask(
      "Escanea el QR con WhatsApp y pulsa Enter al terminar (o escribe 'cancelar'): ",
    )).trim().toLowerCase();
    if (["cancelar", "cancel", "omitir"].includes(choice)) {
      return "Vinculación pospuesta. Puedes mostrar un QR después con /configure channel whatsapp link.";
    }
    await manager.waitUntilConnected("whatsapp", 60_000);
    return "WhatsApp quedó vinculado correctamente.";
  } finally {
    try {
      await manager.stop();
    } finally {
      if (serviceWasRunning) await startService(paths, { registerAutostart: false });
    }
  }
}

async function status() {
  const service = await getServiceStatus(paths);
  const active = (service.channels ?? [])
    .filter(({ status: state }) => state.startsWith("activo"))
    .map(({ type }) => type)
    .join(", ") || "ninguno";
  const failures = (service.channels ?? [])
    .filter(({ status: state }) => state.startsWith("error:"))
    .map(({ type, status: state }) => `${type}: ${state.slice(7)}`) ?? [];
  return [
    `Agente: ${config.name}`,
    `Estado: ${stopping ? "cerrando consola" : "consola activa"}`,
    `Servicio en segundo plano: ${service.running ? "activo" : "detenido"}`,
    `Canales activos: ${active}`,
    ...failures.map((item) => `Error de canal: ${item}`),
    `Proveedor: ${config.provider.name || "personalizado"}`,
    `Modelo: ${config.provider.model ? "configurado" : "pendiente de configurar"}`,
  ].join("\n");
}

async function getAvailableModels() {
  return fetchAvailableModels({
    ...config.provider,
    providerName: config.provider.name,
  });
}

async function listModels() {
  const models = await getAvailableModels();
  if (!models.length) {
    return "El proveedor no informa modelos disponibles. En LM Studio carga uno desde Developer; después consulta /models.";
  }
  return `Modelos disponibles:\n${models.map((model) => `- ${model}`).join("\n")}`;
}

async function formatChannels() {
  const service = await getServiceStatus(paths);
  const channels = service.channels ?? config.channels.map(({ type, enabled }) => ({
    type,
    enabled: enabled !== false,
    status: type === "console"
      ? "activo (panel)"
      : enabled === false
        ? "deshabilitado"
        : "servicio detenido",
  }));
  return channels
    .map(({ type, enabled, status: state }) =>
      `- ${type}: ${enabled ? state : "deshabilitado"}`)
    .join("\n") || "No hay canales configurados.";
}

function formatSkills() {
  const installed = listSkills(paths, config);
  return installed.length
    ? installed.map(({ name, enabled }) =>
      `- ${name}: ${enabled ? "habilitada" : "deshabilitada"}`).join("\n")
    : "No hay skills instaladas.";
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`\nCerrando ${config.name} (${signal})...`);
  const results = await Promise.allSettled([
    terminal.close(),
  ].filter(Boolean));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(`Error al cerrar: ${result.reason.message}`);
      process.exitCode = 1;
    }
  }
}
