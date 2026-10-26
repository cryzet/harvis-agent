import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareWorkDirectory, saveIncomingFile, sanitizeFileName, isTransferSizeAllowed } from "../file-tools.js";

export async function createChannel(config) {
  const token = config.token || process.env.HARVIS_DISCORD_BOT_TOKEN ||
    process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("Falta el token del bot de Discord. Configúralo en /configure > Canales.");
  }

  const requireFromProfile = createRequire(join(config.paths.root, "package.json"));
  const modulePath = requireFromProfile.resolve("discord.js");
  const discord = await import(pathToFileURL(modulePath).href);
  const { Client, GatewayIntentBits, Partials } = discord;
  if (!Client || !GatewayIntentBits || !Partials) {
    throw new Error("La dependencia discord.js no expone la interfaz esperada.");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  return {
    async start({ onMessage }) {
      client.on("messageCreate", async (message) => {
        if (message.author?.bot) return;
        const senderId = String(message.author?.id ?? "");
        if (!config.allowFrom?.includes(senderId)) {
          console.info(`Discord: contacto ${senderId} no autorizado. Autorízalo con /configure channel discord allow ${senderId}.`);
          return;
        }
        try {
          const remoteFile = message.attachments?.first?.();
          if (!message.content?.trim() && !remoteFile) return;
          let attachment;
          if (remoteFile) {
            if (remoteFile.size !== undefined && !isTransferSizeAllowed(remoteFile.size)) {
              await message.reply("El archivo supera el límite de recepción de 16 MB.");
              return;
            }
            const response = await fetch(remoteFile.url);
            if (!response.ok) throw new Error(`No se pudo descargar el adjunto (${response.status}).`);
            const buffer = Buffer.from(await response.arrayBuffer());
            const fileName = sanitizeFileName(remoteFile.name || `discord-${Date.now()}`);
            const filesDir = config.paths.filesDir ?? await prepareWorkDirectory(config.name);
            const savedPath = await saveIncomingFile({ buffer, fileName, workDir: filesDir, channel: "discord" });
            attachment = { path: savedPath, fileName, mimetype: remoteFile.contentType || "application/octet-stream" };
          }
          const answer = await onMessage({
            text: [message.content?.trim(), attachment && `Archivo recibido y guardado: ${attachment.path}.`].filter(Boolean).join("\n"),
            sender: `discord:${message.channelId}:${senderId}`,
            metadata: message,
            attachment,
            role: "admin",
            channelType: "discord",
            sendFile: ({ buffer, fileName, caption = "" }) => message.reply({ content: caption || undefined, files: [{ attachment: buffer, name: fileName }] }),
          });
          if (answer) await message.reply(String(answer));
        } catch (error) {
          console.error(`No se pudo responder en Discord: ${error.message}`);
        }
      });
      await client.login(token);
      console.info(`Discord conectado como ${client.user?.tag ?? "bot"}.`);
    },
    async stop() {
      client.destroy();
    },
  };
}
