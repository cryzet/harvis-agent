import { installSkillPackage } from "./skill-installer.js";
import { createSkill, listSkills, setSkillEnabled } from "./skills.js";
import { installChannel } from "./channel-installer.js";
import {
  createFileToolHandlers,
  fileToolDefinitions,
} from "./file-tools.js";
import { webToolDefinitions } from "./web-tools.js";

export const toolDefinitions = [
  tool("list_channels", "Muestra los canales configurados y su estado.", {}),
  tool("list_skills", "Muestra las skills instaladas y si están habilitadas.", {}),
  tool("create_skill", "Crea una skill local. Escribe instrucciones precisas en formato Markdown.", {
    name: { type: "string", description: "Nombre corto en minúsculas." },
    description: { type: "string", description: "Descripción breve opcional." },
    instructions: { type: "string", description: "Instrucciones completas de la skill." },
  }, ["name", "instructions"]),
  tool("install_skill", "Instala un paquete npm que debe contener SKILL.md. Solicita confirmación al usuario antes de ejecutar npm.", {
    package: { type: "string", description: "Nombre npm de la skill." },
  }, ["package"]),
  tool("install_channel", "Instala un canal de comunicación. Para WhatsApp usa el motor Baileys compatible con OpenClaw. Solicita confirmación antes de ejecutar npm.", {
    name: { type: "string", description: "whatsapp, telegram, discord o nombre de paquete npm." },
  }, ["name"]),
  tool("set_skill_enabled", "Habilita o deshabilita una skill instalada.", {
    name: { type: "string" },
    enabled: { type: "boolean" },
  }, ["name", "enabled"]),
  tool("set_channel_enabled", "Habilita o deshabilita un canal. La consola no se puede deshabilitar.", {
    name: { type: "string", description: "Tipo del canal configurado, por ejemplo whatsapp." },
    enabled: { type: "boolean" },
  }, ["name", "enabled"]),
  ...fileToolDefinitions,
  ...webToolDefinitions,
];

function tool(name, description, properties, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

export function createToolHandlers({
  config,
  paths,
  save,
  confirmInstall,
  installChannel: installChannelHandler,
  getChannelStatuses,
  searchWeb,
  scrapeWebPage,
}) {
  const fileHandlers = createFileToolHandlers();
  return {
    list_channels: async () => getChannelStatuses(),
    list_skills: async () => listSkills(paths, config),
    create_skill: async (args) => {
      const result = createSkill(args, paths, config);
      save();
      return result;
    },
    install_skill: async ({ package: packageName }) =>
      installSkillPackage(packageName, { paths, config, save, confirmInstall }),
    install_channel: async ({ name }) => {
      const confirmationName = name;
      if (typeof confirmInstall !== "function" || !(await confirmInstall(confirmationName, "canal"))) {
        throw new Error("Instalación cancelada por el usuario.");
      }
      return installChannelHandler
        ? installChannelHandler(name)
        : installChannel(name, { config, paths, save });
    },
    set_skill_enabled: async ({ name, enabled }) =>
      setSkillEnabled(name, enabled, paths, config, save),
    set_channel_enabled: async ({ name, enabled }) => {
      const canonicalName = name;
      const channel = config.channels.find(({ type }) => type === canonicalName);
      if (!channel) throw new Error(`El canal "${canonicalName}" no está configurado.`);
      if (canonicalName === "console" && !enabled) {
        throw new Error("El canal de consola no se puede deshabilitar.");
      }
      channel.enabled = enabled;
      save();
      return `Canal "${canonicalName}" ${enabled ? "habilitado" : "deshabilitado"}. Reinicia para aplicar el cambio.`;
    },
    web_search: async ({ query, count }) => searchWeb(query, count),
    web_scrape: async ({ url }) => scrapeWebPage(url),
    ...fileHandlers,
  };
}
