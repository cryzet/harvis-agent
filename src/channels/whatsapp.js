import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  prepareWorkDirectory,
  isTransferSizeAllowed,
  saveIncomingFile,
  sanitizeFileName,
} from "../file-tools.js";
import { getConfiguredAdminNumbers, readIgnoredNumbers } from "../client-access.js";
import {
  getInternationalPhoneNumber,
} from "../phone-number.js";

export async function createChannel(config) {
  const requireFromProfile = createRequire(join(config.paths.root, "package.json"));
  let baileys;
  try {
    const modulePath = requireFromProfile.resolve("baileys");
    baileys = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new Error(
      'Falta baileys. Ejecuta "/configure channel install whatsapp" para instalar el canal.',
      { cause: error },
    );
  }
  const makeWASocket = baileys.default ?? baileys.makeWASocket;
  const { useMultiFileAuthState } = baileys;
  if (typeof makeWASocket !== "function" || typeof useMultiFileAuthState !== "function") {
    throw new Error("La versión instalada de Baileys no expone la interfaz esperada.");
  }
  const pino = requireFromProfile("pino");
  if (typeof pino !== "function") {
    throw new Error("La instalación de Baileys no incluye un logger Pino compatible.");
  }
  const logger = pino({ level: "silent" });

  let socket;
  let saveCreds;
  let stopped = false;
  let reconnectTimer;
  let reconnectAttempt = 0;
  let resolveStartup;
  let startupTimer;
  let startupReady = Promise.resolve();
  let connected = false;
  const connectionWaiters = new Set();
  const adminNumbers = getConfiguredAdminNumbers(config);
  return {
    async start({ onMessage }) {
      const auth = await useMultiFileAuthState(config.paths.whatsappAuthDir);
      saveCreds = auth.saveCreds;
      stopped = false;
      startupReady = new Promise((resolve) => {
        resolveStartup = resolve;
        startupTimer = setTimeout(markStartupReady, 10_000);
      });
      const connect = () => {
        if (stopped) return;
        const current = makeWASocket({
          auth: auth.state,
          browser: ["Harvis", "Desktop", "1.0.0"],
          logger,
        });
        socket = current;
        current.ev.on("creds.update", saveCreds);
        current.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
          if (qr) {
            await printQr(qr, requireFromProfile);
            markStartupReady();
          }
          if (connection === "open") {
            reconnectAttempt = 0;
            connected = true;
            console.info("WhatsApp conectado.");
            for (const waiter of connectionWaiters) waiter.resolve();
            connectionWaiters.clear();
            markStartupReady();
          }
          if (connection === "close" && !stopped && current === socket) {
            connected = false;
            markStartupReady();
            const status = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = status === (baileys.DisconnectReason?.loggedOut ?? 401);
            socket = undefined;
            current.ev.removeAllListeners();
            if (loggedOut) {
              console.error("WhatsApp cerró sesión; ejecuta /configure channel whatsapp para volver a vincular.");
              return;
            }
            const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000);
            reconnectAttempt += 1;
            console.error(`WhatsApp se desconectó (código ${status ?? "desconocido"}); reconexión en ${delay / 1000}s.`);
            reconnectTimer = setTimeout(connect, delay);
          }
        });
        current.ev.on("messages.upsert", async ({ messages, type }) => {
          if (type !== "notify" || current !== socket) return;
          for (const message of messages) {
            const jid = message.key?.remoteJid;
            if (!jid || message.key.fromMe || jid.endsWith("@g.us") || jid === "status@broadcast") continue;
            const content = unwrapMessageContent(message);
            const receivedText = content?.conversation ??
              content?.extendedTextMessage?.text ??
              content?.imageMessage?.caption ??
              content?.videoMessage?.caption ??
              content?.documentMessage?.caption;
            const senderNumbers = [jid, message.key.remoteJidAlt]
              .map(getInternationalPhoneNumber)
              .filter(Boolean);
            const senderNumber = senderNumbers.find((number) => adminNumbers.includes(number)) ??
              senderNumbers[0];
            if (!senderNumber) continue;
            const isAdmin = adminNumbers.includes(senderNumber);
            if (!isAdmin) {
              let ignoredNumbers;
              try {
                ignoredNumbers = await readIgnoredNumbers(config.paths);
              } catch (error) {
                console.error(`No se pudo validar Ignore.txt; se ignoró el mensaje de ${senderNumber}: ${error.message}`);
                continue;
              }
              if (ignoredNumbers.includes(senderNumber)) continue;
            }
            try {
              const media = getIncomingMedia(message);
              if (!receivedText?.trim() && !media) continue;
              if (!isAdmin && media) {
                await current.sendMessage(jid, {
                  text: "Por seguridad, no recibo archivos de clientes. Contacta al administrador.",
                });
                continue;
              }
              let text = receivedText?.trim() ?? "";
              let attachment;
              if (media) {
                if (media.size !== undefined && !isTransferSizeAllowed(media.size)) {
                  await current.sendMessage(jid, {
                    text: `No se recibió ${media.fileName}: supera el límite de 16 MB.`,
                  });
                  continue;
                }
                if (typeof baileys.downloadMediaMessage !== "function") {
                  throw new Error("La versión de Baileys instalada no permite descargar adjuntos.");
                }
                const buffer = await baileys.downloadMediaMessage(
                  message,
                  "buffer",
                  {},
                  { logger, reuploadRequest: current.updateMediaMessage },
                );
                const fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
                const workDir = await prepareWorkDirectory(config.name);
                const savedPath = await saveIncomingFile({
                  buffer: fileBuffer,
                  fileName: media.fileName,
                  workDir,
                });
                attachment = {
                  path: savedPath,
                  fileName: media.fileName,
                  mimetype: media.mimetype,
                };
                text = [text, `Archivo recibido y guardado: ${savedPath}.`]
                  .filter(Boolean)
                  .join("\n");
              }
              await updatePresence(current, "composing", jid);
              let answer;
              try {
                answer = await onMessage({
                  text,
                  sender: jid,
                  metadata: message,
                  attachment,
                  role: isAdmin ? "admin" : "client",
                  channelType: "whatsapp",
                  phoneNumber: senderNumber,
                  ...(isAdmin ? { sendFile: (file) => sendFile(current, jid, file) } : {}),
                });
              } finally {
                await updatePresence(current, "paused", jid);
              }
              if (answer) await current.sendMessage(jid, { text: String(answer) });
            } catch (error) {
              console.error(`No se pudo responder al mensaje de WhatsApp: ${error.message}`);
              try {
                await current.sendMessage(jid, {
                  text: `No pude procesar el mensaje o archivo: ${error.message}`,
                });
              } catch (sendError) {
                console.error(`No se pudo notificar el error por WhatsApp: ${sendError.message}`);
              }
            }
          }
        });
      };
      connect();
    },
    async waitUntilReady() {
      await startupReady;
    },
    async waitUntilConnected(timeout = 120_000) {
      if (connected) return;
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        const timer = setTimeout(() => {
          connectionWaiters.delete(waiter);
          reject(new Error(`WhatsApp no se vinculó en ${timeout / 1000} segundos.`));
        }, timeout);
        waiter.resolve = () => {
          clearTimeout(timer);
          resolve();
        };
        connectionWaiters.add(waiter);
      });
    },
    async stop() {
      stopped = true;
      connected = false;
      clearTimeout(reconnectTimer);
      markStartupReady();
      for (const waiter of connectionWaiters) {
        waiter.reject(new Error("El emparejamiento de WhatsApp se canceló."));
      }
      connectionWaiters.clear();
      if (!socket) return;
      socket.ev.removeAllListeners("messages.upsert");
      socket.ev.removeAllListeners("creds.update");
      socket.ev.removeAllListeners("connection.update");
      socket.end();
      socket = undefined;
    },
  };

  function markStartupReady() {
    clearTimeout(startupTimer);
    startupTimer = undefined;
    resolveStartup?.();
    resolveStartup = undefined;
  }

  async function updatePresence(current, presence, jid) {
    if (current !== socket || typeof current.sendPresenceUpdate !== "function") return;
    try {
      await current.sendPresenceUpdate(presence, jid);
    } catch (error) {
      console.warn(`No se pudo actualizar la presencia de WhatsApp: ${error.message}`);
    }
  }

  async function sendFile(current, jid, { buffer, fileName, mimetype, caption = "" }) {
    if (current !== socket || !connected) throw new Error("WhatsApp no está conectado.");
    if (!Buffer.isBuffer(buffer) || !isTransferSizeAllowed(buffer.length)) {
      throw new Error("El archivo no es válido o supera el límite de envío de 16 MB.");
    }
    const safeName = sanitizeFileName(fileName);
    if (mimetype?.startsWith("image/")) {
      return current.sendMessage(jid, { image: buffer, mimetype, caption });
    }
    return current.sendMessage(jid, {
      document: buffer,
      mimetype: mimetype || "application/octet-stream",
      fileName: safeName,
      caption,
    });
  }
}

function getIncomingMedia(message) {
  const content = unwrapMessageContent(message) ?? {};
  const media = content.imageMessage ?? content.documentMessage ??
    content.videoMessage ?? content.audioMessage;
  if (!media) return null;
  const mime = media.mimetype || "application/octet-stream";
  const extension = ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "application/zip": ".zip",
  })[mime] ?? "";
  return {
    fileName: sanitizeFileName(media.fileName || `whatsapp-${Date.now()}${extension}`),
    mimetype: mime,
    size: media.fileLength === undefined ? undefined : Number(media.fileLength),
  };
}

function unwrapMessageContent(message) {
  let content = message.message;
  while (content?.ephemeralMessage?.message ||
      content?.viewOnceMessage?.message ||
      content?.viewOnceMessageV2?.message ||
      content?.documentWithCaptionMessage?.message) {
    content = content.ephemeralMessage?.message ??
      content.viewOnceMessage?.message ??
      content.viewOnceMessageV2?.message ??
      content.documentWithCaptionMessage?.message;
  }
  return content;
}

async function printQr(qr, requireFromProfile) {
  try {
    const qrPath = requireFromProfile.resolve("qrcode-terminal");
    const qrCode = await import(pathToFileURL(qrPath).href);
    const renderer = qrCode.default ?? qrCode;
    if (typeof renderer.generate !== "function") {
      throw new Error("El módulo no expone una función generate.");
    }

    renderer.generate(qr, { small: true });
  } catch (error) {
    console.warn(`No se pudo renderizar el QR en terminal (${error.message}). No se mostrará el código por seguridad.`);
  }
}
