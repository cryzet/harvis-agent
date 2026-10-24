import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
        if (message.author?.bot || !message.content?.trim()) return;
        const senderId = String(message.author?.id ?? "");
        if (!config.allowFrom?.includes(senderId)) {
          console.info(`Discord: contacto ${senderId} no autorizado. Autorízalo con /configure channel discord allow ${senderId}.`);
          return;
        }
        try {
          const answer = await onMessage({
            text: message.content,
            sender: `discord:${message.channelId}:${senderId}`,
            metadata: message,
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
