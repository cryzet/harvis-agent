import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { normalizeInternationalPhoneNumber } from "./phone-number.js";

export const defaultCustomerReply =
  "Aún no tengo información configurada para responder. El administrador puede actualizarla en Instrucciones.txt.";

export function ensureClientProfileFilesSync(paths) {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  createProfileFileIfMissing(paths.instructionsFile);
  createProfileFileIfMissing(paths.ignoreFile);
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
  const admins = adminNumbers.map(normalizeInternationalPhoneNumber);
  if (admins.includes(normalized)) {
    throw new Error("No se puede agregar a Ignore.txt el número administrador.");
  }
  const ignored = await readIgnoredNumbers(paths);
  const updated = action === "add"
    ? [...new Set([...ignored, normalized])]
    : action === "remove"
      ? ignored.filter((entry) => entry !== normalized)
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
  const candidates = whatsapp?.adminNumber
    ? [whatsapp.adminNumber]
    : (whatsapp?.allowFrom ?? []).filter((value) => String(value).startsWith("+")).slice(0, 1);
  return candidates.map((number) => {
    try {
      return normalizeInternationalPhoneNumber(number);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function createProfileFileIfMissing(path) {
  if (existsSync(path)) return;
  try {
    writeFileSync(path, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
