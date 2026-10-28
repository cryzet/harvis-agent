import { installSkillPackage } from "./skill-installer.js";
import { createSkill, listSkills, setSkillEnabled } from "./skills.js";
import { installChannel } from "./channel-installer.js";
import {
  createFileToolHandlers,
  fileToolDefinitions,
} from "./file-tools.js";
import { webToolDefinitions } from "./web-tools.js";
import {
  createWhatsAppAudioToolHandler,
  whatsappAudioToolDefinition,
} from "./whatsapp-audio-tool.js";

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
  tool("install_channel", "Habilita un canal. WhatsApp y sus dependencias se preparan con el instalador de Harvis; los canales npm externos requieren confirmación antes de instalarse.", {
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
  tool("set_pdf_enabled", "Habilita o deshabilita la herramienta integrada de creación PDF. Solo cambia la configuración si el administrador autenticado lo solicita expresamente.", {
    enabled: { type: "boolean", description: "true para habilitar create_pdf, false para deshabilitarla." },
  }, ["enabled"]),
  tool("set_whatsapp_voice_replies", "Activa o desactiva que las respuestas de WhatsApp también se sinteticen como audio. Solo modifica este ajuste cuando el administrador autenticado lo solicite explícitamente. El texto se enviará al servicio externo Edge TTS para generar el audio.", {
    enabled: { type: "boolean", description: "true para enviar también audio en las respuestas de WhatsApp, false para responder solo con texto." },
  }, ["enabled"]),
  whatsappAudioToolDefinition,
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
  onVoiceRepliesChanged,
  getChannelStatuses,
  searchWeb,
  scrapeWebPage,
  onPdfEnabledChange,
}) {
  const fileHandlers = createFileToolHandlers({ config, paths });
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
      const isPreinstalledWhatsApp = ["whatsapp", "wa"].includes(String(name).trim().toLowerCase());
      if (!isPreinstalledWhatsApp &&
          (typeof confirmInstall !== "function" || !(await confirmInstall(confirmationName, "canal")))) {
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
    ...fileHandlers,
    set_pdf_enabled: async ({ enabled }, context) => {
      if (context?.role !== "admin") {
        throw new Error("Solo el administrador autenticado puede cambiar esta configuración.");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("El estado de la herramienta PDF debe ser true o false.");
      }
      config.pdf ??= { enabled: false };
      config.pdf.enabled = enabled;
      save();
      const applied = onPdfEnabledChange?.(config.pdf.enabled);
      const note = applied === "service"
        ? " El canal ya aplicó el cambio."
        : applied === "console"
          ? " La consola ya aplicó el cambio; ejecuta /restart para actualizar el servicio de canales."
          : " Ejecuta /restart para aplicar el cambio.";
      return `Herramienta de creación PDF ${config.pdf.enabled ? "habilitada" : "deshabilitada"}.${note}`;
    },
    set_whatsapp_voice_replies: async ({ enabled }, context) => {
      if (context?.role !== "admin") {
        throw new Error("Solo el administrador autenticado puede cambiar esta configuración.");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("El estado de las respuestas de voz debe ser true o false.");
      }
      config.voice ??= { whatsappRepliesEnabled: false };
      config.voice.whatsappRepliesEnabled = enabled;
      save();
      const applied = await onVoiceRepliesChanged?.(enabled);
      return `Respuestas de voz por WhatsApp ${enabled ? "activadas" : "desactivadas"}.${applied === "service-restarted" ? " Servicio reiniciado para aplicar el cambio." : ""}`;
    },
    create_pdf: async (args, context) => {
      if (!config.pdf?.enabled) {
        throw new Error("La herramienta PDF está deshabilitada. El administrador puede habilitarla con /configure pdf on y luego ejecutar /restart.");
      }
      return fileHandlers.create_pdf(args, context);
    },
    web_search: async ({ query, count }) => searchWeb(query, count),
    web_scrape: async ({ url }) => scrapeWebPage(url),
    send_whatsapp_audio: createWhatsAppAudioToolHandler(),
  };
}
