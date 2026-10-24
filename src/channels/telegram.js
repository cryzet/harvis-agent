import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
      bot.on("message:text", async (context) => {
        const message = context.message;
        if (!message?.text || message.from?.is_bot) return;
        const senderId = String(message.from?.id ?? "");
        if (!config.allowFrom?.includes(senderId)) {
          console.info(`Telegram: contacto ${senderId} no autorizado. Autorízalo con /configure channel telegram allow ${senderId}.`);
          return;
        }
        try {
          const answer = await onMessage({
            text: message.text,
            sender: `telegram:${message.chat.id}:${senderId}`,
            metadata: message,
            role: "admin",
            channelType: "telegram",
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
