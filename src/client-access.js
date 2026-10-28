import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import {
  normalizeInternationalPhoneNumber,
  normalizeWhatsAppPhoneId,
  samePhoneNumber,
} from "./phone-number.js";

export const defaultCustomerInstructions = [
  "Eres un subagente dedicado a atender a los clientes de la empresa. Tu función es informarles con cordialidad sobre los productos y servicios de la empresa.",
  "Responde preguntas y ofrece soluciones únicamente cuando estén respaldadas por la información de productos y servicios incluida en este archivo. No inventes ni supongas datos.",
  "Si no encuentras la respuesta o la solución que el cliente necesita, deriva su petición al trabajador pertinente usando la herramienta disponible. Elige la etiqueta adecuada entre las guardadas en contacts.txt, por ejemplo Técnico, Vendedor o Atención al cliente. El sistema enviará al trabajador el número del cliente y su petición; no solicites ni reveles números internos.",
  "Si no hay un contacto pertinente configurado o no se pudo completar el envío, informa al cliente con cordialidad que no tienes esa información disponible y que debe consultar con el administrador. No afirmes que la consulta fue derivada si el envío no se confirmó.",
].join("\n\n");

export const defaultCustomerReply =
  "Aún no tengo información configurada para responder. Por favor, consulta con el administrador.";

const contactsFileIntro = [
  "# Contactos privados para avisos internos; no incluyas estos números en Instrucciones.txt.",
  "# Escribe los contactos separados por comas con formato Etiqueta: +número internacional E.164.",
  "# Ejemplo: Técnico: +14155552671, Vendedor: +14155552672",
  "# El subbot selecciona la etiqueta pertinente (por ejemplo Técnico, Vendedor o Atención al cliente) para escalar consultas sin respuesta.",
].join("\n");

export function ensureClientProfileFilesSync(paths) {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  createProfileFileIfMissing(paths.instructionsFile, `${defaultCustomerInstructions}\n`);
  if (!readFileSync(paths.instructionsFile, "utf8").trim()) {
    writeFileSync(paths.instructionsFile, `${defaultCustomerInstructions}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  createProfileFileIfMissing(paths.ignoreFile);
  createProfileFileIfMissing(paths.contactsFile, `${contactsFileIntro}\n`);
  migrateTechnicianContact(paths);
}

export async function readCustomerInstructions(paths) {
  let text;
  try {
    text = await readFile(paths.instructionsFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new Error(`No se pudo leer Instrucciones.txt: ${error.message}`, { cause: error });
  }
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    throw new Error("Instrucciones.txt supera el límite de lectura de 64 KB.");
  }
  return text.trim();
}

export async function readContactList(paths) {
  let text;
  try {
    text = await readFile(paths.contactsFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`No se pudo leer contacts.txt: ${error.message}`, { cause: error });
  }
  if (Buffer.byteLength(text, "utf8") > 16 * 1024) {
    throw new Error("contacts.txt supera el límite de lectura de 16 KB.");
  }
  return parseContacts(text);
}

export async function resolveContactNumber(paths, label) {
  const key = String(label ?? "").trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!key) throw new Error("Indica la etiqueta del contacto.");
  const contacts = await readContactList(paths);
  const contact = contacts.find((entry) => entry.key === key);
  if (!contact) {
    const labels = contacts.map(({ label: contactLabel }) => contactLabel).join(", ");
    throw new Error(labels
      ? `No existe el contacto "${label}". Contactos disponibles: ${labels}.`
      : "No hay contactos configurados en contacts.txt.");
  }
  return contact;
}

export async function readContacts(paths) {
  const contacts = await readContactList(paths);
  return contacts.length
    ? contacts.map(({ label, phoneNumber }) => `${label}: ${phoneNumber}`).join(", ")
    : "No hay contactos configurados.";
}

export async function updateContacts(paths, text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 16 * 1024) {
    throw new Error("La lista de contactos debe ser texto y no superar 16 KB.");
  }
  const contacts = parseContacts(text);
  const unique = new Set();
  for (const contact of contacts) {
    if (unique.has(contact.key)) throw new Error(`El contacto ${contact.label} aparece más de una vez.`);
    unique.add(contact.key);
  }
  const entries = contacts.map(({ label, phoneNumber }) => `${label}: ${phoneNumber}`);
  const content = `${contactsFileIntro}\n${entries.join(", ")}\n`;
  await writeFile(paths.contactsFile, content, { encoding: "utf8", mode: 0o600 });
  return entries.length
    ? `contacts.txt actualizado: ${contacts.map(({ label }) => label).join(", ")}.`
    : "contacts.txt actualizado sin números de contacto.";
}

export async function updateCustomerInstructions(paths, text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Las instrucciones no pueden quedar vacías.");
  }
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    throw new Error("Instrucciones.txt no puede superar 64 KB.");
  }
  await writeFile(paths.instructionsFile, `${text.trim()}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return "Instrucciones.txt actualizado.";
}

export async function readIgnoredNumbers(paths) {
  let content;
  try {
    content = await readFile(paths.ignoreFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`No se pudo leer Ignore.txt; se bloqueará el acceso de clientes: ${error.message}`, {
      cause: error,
    });
  }
  return content.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((number) => {
      try {
        return normalizeInternationalPhoneNumber(number);
      } catch (error) {
        throw new Error(`Ignore.txt contiene un número inválido: ${number}`, { cause: error });
      }
    });
}

export async function changeIgnoredNumber(paths, number, action, adminNumbers = []) {
  const normalized = normalizeInternationalPhoneNumber(number);
  if (adminNumbers.some((admin) => samePhoneNumber(admin, normalized))) {
    throw new Error("No se puede agregar a Ignore.txt el número administrador.");
  }
  const ignored = await readIgnoredNumbers(paths);
  const updated = action === "add"
    ? ignored.some((entry) => samePhoneNumber(entry, normalized))
      ? ignored
      : [...ignored, normalized]
    : action === "remove"
      ? ignored.filter((entry) => !samePhoneNumber(entry, normalized))
      : null;
  if (!updated) throw new Error('La acción debe ser "add" o "remove".');
  await writeFile(paths.ignoreFile, updated.length ? `${updated.join("\n")}\n` : "", {
    encoding: "utf8",
    mode: 0o600,
  });
  return action === "add"
    ? `Número agregado a Ignore.txt: ${normalized}.`
    : `Número eliminado de Ignore.txt: ${normalized}.`;
}

export function getConfiguredAdminNumbers(config = {}) {
  const whatsapp = (config.channels ?? []).find(({ type }) => type === "whatsapp") ??
    (config.type === "whatsapp" || Array.isArray(config.allowFrom) ? config : undefined);
  const candidates = whatsapp?.adminNumber ? [whatsapp.adminNumber] : (whatsapp?.allowFrom ?? []);
  const phoneId = candidates.map(normalizeWhatsAppPhoneId).find(Boolean);
  return phoneId ? [`+${phoneId}`] : [];
}

function createProfileFileIfMissing(path, initialContent = "") {
  if (existsSync(path)) return;
  try {
    writeFileSync(path, initialContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

function migrateTechnicianContact(paths) {
  const instructionsText = readFileSync(paths.instructionsFile, "utf8");
  const legacyPattern = /^\s*(?:TECNICO_WHATSAPP|T[eé]cnico|WhatsApp\s+del\s+t[eé]cnico|N[uú]mero\s+(?:de\s+)?WhatsApp\s+(?:del\s+)?t[eé]cnico)\s*[:=]\s*(.*?)\s*$/i;
  const lines = instructionsText.split(/\r?\n/);
  const legacyEntries = lines.map((line) => ({ line, match: legacyPattern.exec(line) }))
    .filter(({ match }) => match);
  if (!legacyEntries.length) return;

  const contactText = readFileSync(paths.contactsFile, "utf8");
  const contacts = parseContacts(contactText);
  if (!contacts.some(({ key }) => key === "tecnico")) {
    const legacy = legacyEntries[0].match[1];
    let phoneNumber;
    try {
      phoneNumber = normalizeInternationalPhoneNumber(legacy);
    } catch {
      return;
    }
    contacts.push({ label: "Técnico", key: "tecnico", phoneNumber });
    const entries = contacts.map(({ label, phoneNumber: number }) => `${label}: ${number}`);
    writeFileSync(paths.contactsFile, `${contactsFileIntro}\n${entries.join(", ")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  const cleanedInstructions = lines.filter((line) => !legacyPattern.test(line)).join("\n").trim();
  writeFileSync(paths.instructionsFile, cleanedInstructions ? `${cleanedInstructions}\n` : "", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function parseContacts(text) {
  const contacts = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    for (const entry of line.split(/[,;]+/)) {
      if (!entry.trim()) continue;
      const separator = entry.indexOf(":");
      if (separator < 0) throw new Error(`Formato inválido en contacts.txt: ${entry.trim()}`);
      const label = entry.slice(0, separator).trim();
      const key = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      if (!/^[\p{L}][\p{L} _-]{0,39}$/u.test(label)) {
        throw new Error(`Etiqueta inválida en contacts.txt: ${label}`);
      }
      let phoneNumber;
      try {
        phoneNumber = normalizeInternationalPhoneNumber(entry.slice(separator + 1).trim());
      } catch (error) {
        throw new Error(`El número del contacto ${label} no es válido. ${error.message}`, { cause: error });
      }
      contacts.push({ label, key, phoneNumber });
      if (contacts.filter((contact) => contact.key === key).length > 1) {
        throw new Error(`La etiqueta ${label} aparece más de una vez en contacts.txt.`);
      }
    }
  }
  return contacts;
}
