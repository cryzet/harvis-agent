import { createRequire } from "node:module";
import { resolve } from "node:path";

export function checkSetup(config, paths) {
  const issues = [];

  try {
    const url = new URL(config.provider.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
  } catch {
    issues.push("La URL del proveedor no es válida; configúrala como HTTP o HTTPS.");
  }
  if (typeof config.provider.model !== "string" || !config.provider.model.trim()) {
    issues.push("No hay un modelo configurado para el proveedor.");
  }

  for (const channel of config.channels) {
    if (channel.type === "console" || channel.enabled === false) continue;
    const dependencies = {
      whatsapp: "baileys",
      telegram: "grammy",
      discord: "discord.js",
    };
    if (dependencies[channel.type]) {
      if (channel.type === "telegram" && !channel.token) {
        issues.push("Telegram no tiene token de bot. Configúralo en /configure > Canales.");
      }
      if (channel.type === "discord" && !channel.token) {
        issues.push("Discord no tiene token de bot. Configúralo en /configure > Canales.");
      }
      try {
        createRequire(resolve(paths.root, "package.json")).resolve(dependencies[channel.type]);
      } catch {
        issues.push(`Falta la dependencia del canal ${channel.type}. Instálala desde /configure > Canales.`);
      }
      continue;
    }
    if (!channel.module) {
      issues.push(`El canal "${channel.type}" no tiene un módulo configurado.`);
      continue;
    }
    const packageBase = resolve(paths.channelsDir, channel.installDir ?? channel.type);
    try {
      createRequire(resolve(packageBase, "package.json")).resolve(channel.module);
    } catch {
      issues.push(`No se encontró el módulo instalado para el canal "${channel.type}".`);
    }
  }

  return issues;
}

export async function runStartupSetup({ terminal, config, paths, interactive }) {
  if (interactive && config.setupComplete !== true) {
    const result = await terminal.onboard();
    if (result && result !== "Setup completado.") console.info(result);
    if (config.setupComplete !== true) {
      return checkSetup(config, paths);
    }
  }

  const issues = checkSetup(config, paths);
  if (!issues.length) return [];

  console.warn("\n◆ Verificación de configuración:");
  for (const issue of issues) console.warn(`  - ${issue}`);

  if (!interactive) {
    console.warn("Ejecuta /configure desde una consola interactiva para corregirlo.\n");
    return issues;
  }

  console.info("Abriendo /configure para revisar la configuración.");
  const result = await terminal.configure([]);
  if (result) console.log(`\n${result}`);

  const remaining = checkSetup(config, paths);
  if (remaining.length) {
    console.warn("\nLa configuración todavía requiere atención:");
    for (const issue of remaining) console.warn(`  - ${issue}`);
    console.warn("Puedes volver a ejecutar /configure después de iniciar.\n");
  }
  return remaining;
}
