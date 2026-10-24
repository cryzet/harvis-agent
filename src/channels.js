import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createChannel as createWhatsAppChannel } from "./channels/whatsapp.js";
import { createChannel as createTelegramChannel } from "./channels/telegram.js";
import { createChannel as createDiscordChannel } from "./channels/discord.js";

export class ChannelManager {
  constructor(config, paths, onMessage, save) {
    this.config = config;
    this.paths = paths;
    this.onMessage = onMessage;
    this.save = save;
    this.active = new Map();
    this.statuses = new Map();
  }

  async start({ types } = {}) {
    for (const entry of this.config.channels) {
      if (entry.type === "console" || entry.enabled === false) continue;
      if (types && !types.includes(entry.type)) continue;
      try {
        const channel = await this.load(entry);
        await channel.start({ onMessage: this.onMessage });
        this.active.set(entry.type, channel);
        await channel.waitUntilReady?.();
        this.statuses.set(entry.type, "activo");
      } catch (error) {
        this.statuses.set(entry.type, `error: ${error.message}`);
        console.error(`No se pudo iniciar "${entry.type}": ${error.message}`);
      }
    }
  }

  async stop() {
    const stopped = await Promise.allSettled(
      [...this.active.values()].map((channel) => channel.stop()),
    );
    this.active.clear();
    this.statuses.clear();
    const errors = stopped.filter(({ status }) => status === "rejected")
      .map(({ reason }) => reason);
    if (errors.length) throw new AggregateError(errors, "Falló el cierre de uno o más canales.");
  }

  list() {
    return this.config.channels.map(({ type, enabled }) => ({
      type,
      enabled: enabled !== false,
      status: type === "console" ? "activo (panel)" : this.statuses.get(type) ?? "inactivo",
    }));
  }

  async load(entry) {
    if (entry.type === "telegram") {
      return createTelegramChannel({ ...entry, paths: this.paths });
    }
    if (entry.type === "discord") {
      return createDiscordChannel({ ...entry, paths: this.paths });
    }
    if (entry.type === "whatsapp") {
      entry.allowFrom ??= [];
      return createWhatsAppChannel({
        ...entry,
        paths: this.paths,
      });
    }
    if (!entry.module) {
      throw new Error(`El canal "${entry.type}" no tiene un módulo instalado.`);
    }
    const packageBase = resolve(this.paths.channelsDir, entry.installDir ?? entry.type);
    const requireFromPlugin = createRequire(resolve(packageBase, "package.json"));
    const modulePath = pathToFileURL(requireFromPlugin.resolve(entry.module)).href;
    const plugin = await import(modulePath);
    if (typeof plugin.createChannel !== "function") {
      throw new Error(`El módulo ${entry.module} debe exportar createChannel(config).`);
    }
    return plugin.createChannel({ ...entry, paths: this.paths });
  }

  waitUntilConnected(type, timeout) {
    const channel = this.active.get(type);
    if (!channel?.waitUntilConnected) {
      throw new Error(`El canal "${type}" no está activo o no admite emparejamiento interactivo.`);
    }
    return channel.waitUntilConnected(timeout);
  }

  authorize(type, senderId) {
    const entry = this.config.channels.find((channel) => channel.type === type);
    if (!entry) throw new Error(`El canal "${type}" no está instalado.`);
    const id = String(senderId).trim();
    if (!id) throw new Error("El identificador del contacto no puede estar vacío.");
    entry.allowFrom ??= [];
    if (!entry.allowFrom.includes(id)) entry.allowFrom.push(id);
    this.save?.();
    return `Contacto autorizado en ${type}: ${id}.`;
  }
}
