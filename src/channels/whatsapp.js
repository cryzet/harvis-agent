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
import { transcribeVoiceMessage } from "../speech-recognition.js";
import { synthesizeSpanishSpeech } from "../text-to-speech.js";
import {
  normalizeInternationalPhoneNumber,
  normalizeWhatsAppPhoneId,
  samePhoneNumber,
} from "../phone-number.js";

export async function createChannel(config) {
  const voiceRepliesEnabled = () => config.getVoiceRepliesEnabled?.() === true;
  const requireFromProfile = createRequire(join(config.paths.root, "package.json"));
  const requireFromApplication = createRequire(new URL("../../package.json", import.meta.url));
  const resolveDependency = (name) => {
    try { return requireFromProfile.resolve(name); }
    catch { return requireFromApplication.resolve(name); }
  };
  let baileys;
  try {
    const modulePath = resolveDependency("baileys");
    baileys = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new Error(
      "Falta Baileys. Ejecuta npm start o npm run install:agent para preparar las dependencias de Harvis.",
      { cause: error },
    );
  }
  const makeWASocket = baileys.default ?? baileys.makeWASocket;
  const { useMultiFileAuthState } = baileys;
  if (typeof makeWASocket !== "function" || typeof useMultiFileAuthState !== "function") {
    throw new Error("La versión instalada de Baileys no expone la interfaz esperada.");
  }
  let pino;
  try {
    const pinoPath = resolveDependency("pino");
    const pinoModule = await import(pathToFileURL(pinoPath).href);
    pino = pinoModule.default ?? pinoModule;
  } catch (error) {
    throw new Error("La instalación de Baileys no incluye un logger Pino compatible.", { cause: error });
  }
  if (typeof pino !== "function") {
    throw new Error("La instalación de Baileys no incluye un logger Pino compatible.");
  }
  const logger = pino({ level: "silent" });

  let socket;
  let saveCreds;
  let stopped = false;
  let incomingMessageQueue = Promise.resolve();
  let reconnectTimer;
  let reconnectAttempt = 0;
  let resolveStartup;
  let startupTimer;
  let startupReady = Promise.resolve();
  let connected = false;
  const connectionWaiters = new Set();
  // OpenClaw canonicalizes WhatsApp allowlist and inbound sender IDs to
  // digit-only phone IDs. Keep that same representation for every comparison.
  const configuredAdminNumbers = getConfiguredAdminNumbers(config);
  const adminNumbers = configuredAdminNumbers.map(normalizeWhatsAppPhoneId).filter(Boolean);
  const adminIdentity = config.adminIdentity;
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
        // Baileys 7 may learn a PN ↔ LID pair outside a messages.upsert event.
        // Keep the administrator's pair when that happens so future LID-only
        // messages remain authenticated after proactive messages or reconnects.
        current.ev.on("lid-mapping.update", async (update) => {
          const lid = update?.lid ?? update?.mapping?.lid;
          const pn = update?.pn ?? update?.phoneNumber ?? update?.mapping?.pn;
          const phoneId = normalizeWhatsAppPhoneId(pn);
          if (lid && phoneId && adminNumbers.includes(phoneId)) {
            await rememberAdminJids(current, [lid, pn]);
          }
        });
        current.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
          if (qr) {
            await printQr(qr, resolveDependency);
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
        current.ev.on("messages.upsert", (upsert) => {
          incomingMessageQueue = incomingMessageQueue.catch(() => {})
            .then(async () => {
              const { messages, type } = upsert;
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
            const messageJids = getMessageIdentifiers(message);
            const senderNumbers = await resolveMessagePhoneNumbers(messageJids, current);
            const hasAdminIdentity = typeof adminIdentity?.id === "string" &&
              adminIdentity.id === adminNumbers[0] &&
              normalizeWhatsAppPhoneId(adminIdentity.phoneNumber) === adminNumbers[0];
            // Merge both fields during migration: older builds stored aliases
            // only in adminJids, while newer builds persist them on identity.
            const identityJids = hasAdminIdentity
              ? [
                ...(Array.isArray(adminIdentity.jids) ? adminIdentity.jids : []),
                ...(Array.isArray(config.adminJids) ? config.adminJids : []),
              ]
              : [];
            const adminJids = new Set((Array.isArray(identityJids) ? identityJids : [])
              .map(normalizeWhatsAppJid).filter(Boolean));
            const knownAdminJid = hasAdminIdentity && messageJids.some((identifier) =>
              adminJids.has(normalizeWhatsAppJid(identifier)));
            const matchedAdminNumber = senderNumbers.find((number) =>
              hasAdminIdentity
                ? normalizeWhatsAppPhoneId(number) === adminNumbers[0]
                : adminNumbers.includes(normalizeWhatsAppPhoneId(number)));
            const senderNumber = matchedAdminNumber ??
              (knownAdminJid ? (adminIdentity?.phoneNumber ?? configuredAdminNumbers[0]) : senderNumbers[0]);
            if (!senderNumber) continue;
            const isAdmin = hasAdminIdentity
              ? knownAdminJid || normalizeWhatsAppPhoneId(matchedAdminNumber) === adminNumbers[0]
              : adminNumbers.includes(normalizeWhatsAppPhoneId(senderNumber));
            if (isAdmin) await rememberAdminJids(current, messageJids);
            if (!isAdmin) {
              let ignoredNumbers;
              try {
                ignoredNumbers = await readIgnoredNumbers(config.paths);
              } catch (error) {
                console.error(`No se pudo validar Ignore.txt; se ignoró el mensaje de ${senderNumber}: ${error.message}`);
                continue;
              }
              if (ignoredNumbers.some((number) => samePhoneNumber(number, senderNumber))) continue;
            }
            try {
              const media = getIncomingMedia(message);
              if (!receivedText?.trim() && !media) continue;
              if (!isAdmin && media && media.kind !== "audio") {
                await current.sendMessage(jid, {
                  text: "Por seguridad, no recibo archivos de clientes. Contacta al administrador.",
                });
                continue;
              }
              let text = receivedText?.trim() ?? "";
              if (isAdmin && /^\/voz\s+(on|off|estado)$/i.test(text)) {
                const [, action] = text.match(/^\/voz\s+(on|off|estado)$/i);
                if (action.toLowerCase() === "estado") {
                  await current.sendMessage(jid, {
                    text: `Respuestas de voz por WhatsApp: ${voiceRepliesEnabled() ? "activadas" : "desactivadas"}.`,
                  });
                } else {
                  await config.setVoiceRepliesEnabled?.(action.toLowerCase() === "on");
                  await current.sendMessage(jid, {
                    text: `Respuestas de voz por WhatsApp ${action.toLowerCase() === "on" ? "activadas" : "desactivadas"}.`,
                  });
                }
                continue;
              }
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
                let buffer;
                try {
                  buffer = await baileys.downloadMediaMessage(
                    message,
                    "buffer",
                    {},
                    { logger, reuploadRequest: current.updateMediaMessage },
                  );
                } catch (error) {
                  throw new Error(`WhatsApp no pudo descargar el archivo adjunto: ${error.message}`, { cause: error });
                }
                const fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
                if (media.kind === "audio") {
                  await updatePresence(current, "composing", jid);
                  let transcript;
                  try {
                    transcript = await transcribeVoiceMessage(fileBuffer);
                  } catch (error) {
                    throw new Error(`Falló la transcripción local del audio: ${error.message}`, { cause: error });
                  }
                  text = [text, `Transcripción del mensaje de voz: ${transcript}`]
                    .filter(Boolean)
                    .join("\n");
                } else {
                  const workDir = config.paths.filesDir ?? await prepareWorkDirectory(config.name);
                  const savedPath = await saveIncomingFile({
                    buffer: fileBuffer,
                    fileName: media.fileName,
                    workDir,
                    channel: "whatsapp",
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
              }
              const requestedReplyFormat = detectWhatsAppReplyFormat(text);
              const voiceAudioEnabled = voiceRepliesEnabled();
              const replyFormat = requestedReplyFormat ?? "text";
              let requestedAudioText;
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
                  replyFormat,
                  voiceAudioEnabled,
                  audioRequested: requestedReplyFormat === "audio",
                  sendWhatsAppAudio: (audioText) => {
                    if (requestedAudioText) {
                      throw new Error("Ya se solicitó el envío de audio para esta respuesta.");
                    }
                    requestedAudioText = String(audioText ?? "").trim();
                    return "Respuesta de audio preparada para enviarse al finalizar el turno.";
                  },
                  phoneNumber: senderNumber,
                  ...(isAdmin ? { sendFile: (file) => sendFile(current, jid, file) } : {}),
                  sendContactMessage: (message) => sendContactMessage(current, message),
                });
              } finally {
                await updatePresence(current, "paused", jid);
              }
              if (answer) {
                const responseText = String(answer);
                if (requestedAudioText) {
                  try {
                    const audio = await synthesizeSpanishSpeech(requestedAudioText);
                    if (!isTransferSizeAllowed(audio.length)) {
                      throw new Error("El audio generado supera el límite de envío de 16 MB.");
                    }
                    await current.sendMessage(jid, { audio, mimetype: "audio/mpeg" });
                  } catch (error) {
                    console.warn(`No se pudo generar o enviar la respuesta de voz por WhatsApp: ${error.message}`);
                    await current.sendMessage(jid, { text: requestedAudioText });
                  }
                } else {
                  await current.sendMessage(jid, { text: responseText });
                }
              }
            } catch (error) {
              console.error(`No se pudo responder al mensaje de WhatsApp: ${error.message}`);
              try {
                await updatePresence(current, "paused", jid);
                await current.sendMessage(jid, {
                  text: `No pude procesar el mensaje o archivo: ${error.name === "TimeoutError" || error.name === "AbortError" ? "se agotó el tiempo esperando el modelo Whisper. Revisa la conexión a huggingface.co e inténtalo de nuevo." : error.message}`,
                });
              } catch (sendError) {
                console.error(`No se pudo notificar el error por WhatsApp: ${sendError.message}`);
              }
            }
          }
            })
            .catch((error) => {
              console.error(`No se pudo procesar una tanda de mensajes de WhatsApp: ${error.message}`);
            });
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

  async function sendContactMessage(current, { phoneNumber, text }) {
    if (current !== socket || !connected) throw new Error("WhatsApp no está conectado.");
    const normalized = normalizeInternationalPhoneNumber(phoneNumber);
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("El aviso al técnico no contiene texto.");
    }
    const jid = `${normalized.slice(1)}@s.whatsapp.net`;
    const result = await current.sendMessage(jid, { text: text.slice(0, 4000) });
    if (adminNumbers.includes(normalizeWhatsAppPhoneId(normalized))) {
      await rememberAdminJids(current, [jid, ...getMessageIdentifiers(result)]);
    }
    return result;
  }

  async function rememberAdminJids(current, identifiers) {
    const existingAliases = [
      ...(Array.isArray(config.adminJids) ? config.adminJids : []),
      ...(Array.isArray(adminIdentity?.jids) ? adminIdentity.jids : []),
    ].map(normalizeWhatsAppJid).filter(Boolean);
    const aliases = new Set(existingAliases);
    const lidMapping = current.signalRepository?.lidMapping;
    for (const identifier of identifiers) {
      const normalized = normalizeWhatsAppJid(identifier);
      if (!normalized || !normalized.includes("@")) continue;
      aliases.add(normalized);
      if (normalized.endsWith("@lid") && typeof lidMapping?.getPNForLID === "function") {
        try {
          const pn = normalizeWhatsAppJid(await lidMapping.getPNForLID(normalized));
          if (pn) aliases.add(pn);
        } catch {
          // Keep the LID itself; it will still identify the configured administrator.
        }
      }
      if (normalized.endsWith("@s.whatsapp.net") && typeof lidMapping?.getLIDForPN === "function") {
        try {
          const lid = normalizeWhatsAppJid(await lidMapping.getLIDForPN(normalized));
          if (lid) aliases.add(lid);
        } catch {
          // The PN remains a valid identifier when no LID mapping is cached.
        }
      }
    }
    const nextAliases = [...aliases].slice(-20);
    if (nextAliases.length === existingAliases.length &&
        nextAliases.every((alias) => existingAliases.includes(alias)) &&
        config.adminJids?.length === nextAliases.length) return;
    config.adminJids = nextAliases;
    if (adminIdentity?.id === adminNumbers[0] &&
        normalizeWhatsAppPhoneId(adminIdentity.phoneNumber) === adminNumbers[0]) {
      adminIdentity.jids = nextAliases;
    }
    try {
      await config.saveAdminJids?.(nextAliases);
    } catch (error) {
      console.warn(`No se pudo guardar el identificador WhatsApp del administrador: ${error.message}`);
    }
  }
}

function detectWhatsAppReplyFormat(text) {
  const normalized = String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/\b(solo texto|solo por escrito|en texto|por escrito|sin audio|no (?:me )?(?:mandes|envies|respondas con) (?:un )?(?:audio|nota de voz))\b/.test(normalized)) {
    return "text";
  }
  if (/\b(?:responde|respondeme|contesta|contestame|envia|enviame|manda|mandame)\b.{0,35}\b(?:audio|voz|nota de voz)\b|\b(?:en|por) (?:un )?(?:audio|voz|nota de voz)\b/.test(normalized)) {
    return "audio";
  }
  return undefined;
}

function getMessageIdentifiers(message) {
  const key = message?.key ?? message ?? {};
  return [
    key.remoteJidAlt,
    key.senderPn,
    key.participantAlt,
    key.participantPn,
    key.remoteJid,
    key.participant,
  ].filter((value) => typeof value === "string");
}

function normalizeWhatsAppJid(value) {
  if (typeof value !== "string") return null;
  const jid = value.trim().replace(/:\d+(?=@)/, "").toLowerCase();
  return /^(?:[1-9]\d{7,14}|\d+)@(s\.whatsapp\.net|lid)$/.test(jid) ? jid : null;
}

async function resolveMessagePhoneNumbers(identifiers, socket) {
  const numbers = new Set();
  for (const identifier of identifiers) {
    const phoneId = normalizeWhatsAppPhoneId(identifier);
    if (phoneId) numbers.add(`+${phoneId}`);
  }

  const lidMapping = socket.signalRepository?.lidMapping;
  if (typeof lidMapping?.getPNForLID === "function") {
    for (const identifier of identifiers.filter((value) => value.endsWith("@lid"))) {
      const normalizedLid = identifier.replace(/:\d+@lid$/, "@lid");
      for (const lid of new Set([identifier, normalizedLid])) {
        try {
          const phoneJid = await lidMapping.getPNForLID(lid);
          const phoneId = normalizeWhatsAppPhoneId(phoneJid);
          if (phoneId) numbers.add(`+${phoneId}`);
        } catch {
          // Baileys may not have a cached PN mapping for every LID yet.
        }
      }
    }
  }
  return [...numbers];
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
    kind: content.audioMessage ? "audio" : "file",
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

async function printQr(qr, resolveDependency) {
  try {
    const qrPath = resolveDependency("qrcode-terminal");
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
