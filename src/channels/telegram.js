import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareWorkDirectory, saveIncomingFile, sanitizeFileName, isTransferSizeAllowed } from "../file-tools.js";

export async function createChannel(config) {
  const token = config.token || process.env.HARVIS_TELEGRAM_BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Falta el token del bot de Telegram. Configúralo en /configure > Canales.");
  }

  const requireFromProfile = createRequire(join(config.paths.root, "package.json"));
  const modulePath = requireFromProfile.resolve("grammy");
  const grammy = await import(pathToFileURL(modulePath).href);
  const Bot = grammy.Bot ?? grammy.default?.Bot;
  if (typeof Bot !== "function") {
    throw new Error("La dependencia grammY no expone Bot.");
  }
  const bot = new Bot(token);

  return {
    async start({ onMessage }) {
      bot.on("message", async (context) => {
        const message = context.message;
        if (!message || message.from?.is_bot) return;
        const senderId = String(message.from?.id ?? "");
        if (!config.allowFrom?.includes(senderId)) {
          console.info(`Telegram: contacto ${senderId} no autorizado. Autorízalo con /configure channel telegram allow ${senderId}.`);
          return;
        }
        try {
          let attachment;
          const doc = message.document;
          const photo = message.photo?.at(-1);
          const media = doc ?? photo;
          if (!message.text?.trim() && !media) return;
          if (media) {
            if (media.file_size !== undefined && !isTransferSizeAllowed(media.file_size)) {
              await context.reply("El archivo supera el límite de recepción de 16 MB.");
              return;
            }
            const remote = await context.getFile(media.file_id);
            const url = await remote.getUrl();
            const response = await fetch(url);
            if (!response.ok) throw new Error(`No se pudo descargar el adjunto (${response.status}).`);
            const buffer = Buffer.from(await response.arrayBuffer());
            const fileName = sanitizeFileName(doc?.file_name || `telegram-${Date.now()}${photo ? ".jpg" : ""}`);
            const filesDir = config.paths.filesDir ?? await prepareWorkDirectory(config.name);
            const savedPath = await saveIncomingFile({ buffer, fileName, workDir: filesDir, channel: "telegram" });
            attachment = { path: savedPath, fileName, mimetype: doc?.mime_type || "image/jpeg" };
          }
          const answer = await onMessage({
            text: [message.text?.trim(), attachment && `Archivo recibido y guardado: ${attachment.path}.`].filter(Boolean).join("\n"),
            sender: `telegram:${message.chat.id}:${senderId}`,
            metadata: message,
            attachment,
            role: "admin",
            channelType: "telegram",
            sendFile: ({ buffer, fileName, caption = "" }) => bot.api.sendDocument(message.chat.id, new grammy.InputFile(buffer, fileName), { caption }),
          });
          if (answer) await context.reply(String(answer));
        } catch (error) {
          console.error(`No se pudo responder en Telegram: ${error.message}`);
        }
      });
      await bot.api.getMe();
      void bot.start({
        onStart: (identity) => console.info(`Telegram conectado como @${identity.username}.`),
      }).catch((error) => {
        console.error(`Se perdió la conexión con Telegram: ${error.message}`);
      });
    },
    async stop() {
      await bot.stop();
    },
  };
}
