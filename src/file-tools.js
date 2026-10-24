import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import mammoth from "mammoth";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

const maxTextBytes = 1024 * 1024;
const maxImageBytes = 12 * 1024 * 1024;
const maxTransferBytes = 16 * 1024 * 1024;
const allowedTextExtensions = new Set([
  ".txt", ".md", ".csv", ".json", ".log", ".yaml", ".yml", ".xml", ".html", ".htm",
]);

export const fileToolDefinitions = [
  tool("list_files", "Lista archivos y carpetas de una ruta dentro de la carpeta personal. Requiere autorización previa.", {
    path: { type: "string", description: "Ruta relativa a la carpeta personal; por defecto, la raíz." },
  }),
  tool("read_file", "Lee un archivo de texto o una imagen dentro de la carpeta personal. Requiere autorización previa.", {
    path: { type: "string", description: "Ruta relativa o absoluta dentro de la carpeta personal." },
  }, ["path"]),
  tool("write_file", "Crea o reemplaza un archivo dentro de la carpeta personal. Requiere autorización previa.", {
    path: { type: "string", description: "Ruta relativa o absoluta dentro de la carpeta personal; la carpeta debe existir." },
    content: { type: "string", description: "Contenido de texto que se guardará." },
  }, ["path", "content"]),
  tool("delete_file", "Elimina un archivo (no una carpeta) dentro de la carpeta personal. Requiere autorización previa.", {
    path: { type: "string", description: "Ruta relativa o absoluta dentro de la carpeta personal." },
  }, ["path"]),
  tool("send_file", "Envía por WhatsApp un archivo de la carpeta personal al usuario que lo solicitó. Requiere autorización previa.", {
    path: { type: "string", description: "Ruta relativa o absoluta dentro de la carpeta personal." },
    caption: { type: "string", description: "Texto opcional que acompaña al archivo." },
  }, ["path"]),
];

export function createFileToolHandlers() {
  return {
    list_files: async ({ path = "." } = {}, context) => {
      const target = await resolveSafePath(path);
      await requireApproval(context, `listar el contenido de ${displayPath(target)}`);
      const entries = await readdir(target, { withFileTypes: true });
      return entries.slice(0, 200).map((entry) =>
        `${entry.isDirectory() ? "[carpeta]" : "[archivo]"} ${entry.name}`,
      ).join("\n") || "La carpeta está vacía.";
    },
    read_file: async ({ path }, context) => {
      const target = await resolveSafePath(path);
      await requireApproval(context, `leer ${displayPath(target)}`);
      const info = await stat(target);
      if (!info.isFile()) throw new Error("Solo se pueden leer archivos, no carpetas.");
      const extension = extname(target).toLowerCase();
      if (info.size > maxImageBytes) {
        throw new Error(`El archivo supera el límite de lectura de ${formatBytes(maxImageBytes)}.`);
      }
      const buffer = await readFile(target);
      if (isImageExtension(extension)) {
        return {
          type: "image",
          mimetype: imageMimeType(extension),
          data: buffer.toString("base64"),
          text: `Imagen leída: ${displayPath(target)}`,
        };
      }
      if (extension === ".pdf") {
        if (!supportsPdfParserRuntime()) {
          throw new Error("La extracción de texto PDF requiere Node.js 20.16+ o 22.3+.");
        }
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: buffer });
        try {
          const result = await parser.getText();
          if (!result.text.trim()) {
            throw new Error("El PDF no contiene texto extraíble; los PDF escaneados con imágenes requieren OCR.");
          }
          return `Texto extraído de ${displayPath(target)}:\n${result.text.slice(0, maxTextBytes)}`;
        } finally {
          await parser.destroy();
        }
      }
      if (extension === ".docx") {
        const result = await mammoth.extractRawText({ buffer });
        return `Texto extraído de ${displayPath(target)}:\n${result.value.slice(0, maxTextBytes)}`;
      }
      if (!allowedTextExtensions.has(extension) || info.size > maxTextBytes) {
        throw new Error("Se admiten texto de hasta 1 MB, documentos PDF/DOCX e imágenes de hasta 12 MB.");
      }
      if (buffer.includes(0)) throw new Error("El archivo parece binario y no se puede leer como texto.");
      return buffer.toString("utf8");
    },
    write_file: async ({ path, content }, context) => {
      if (typeof content !== "string") throw new Error("El contenido debe ser texto.");
      if (Buffer.byteLength(content) > maxTextBytes) {
        throw new Error("El contenido supera el límite de escritura de 1 MB.");
      }
      const target = await resolveSafePath(path, { allowMissing: true });
      await requireApproval(
        context,
        `crear o reemplazar ${displayPath(target)} (${Buffer.byteLength(content)} bytes)`,
      );
      try {
        if ((await lstat(target)).isSymbolicLink()) {
          throw new Error("No se permite reemplazar enlaces simbólicos.");
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await writeFile(target, content, { encoding: "utf8", flag: "w", mode: 0o600 });
      return `Archivo guardado: ${displayPath(target)}.`;
    },
    delete_file: async ({ path }, context) => {
      const target = await resolveSafePath(path);
      await requireApproval(context, `eliminar ${displayPath(target)}`);
      if (!(await stat(target)).isFile()) throw new Error("Solo se pueden eliminar archivos, no carpetas.");
      await unlink(target);
      return `Archivo eliminado: ${displayPath(target)}.`;
    },
    send_file: async ({ path, caption = "" }, context) => {
      if (typeof context?.sendFile !== "function") {
        throw new Error("El envío de archivos solo está disponible en una conversación de WhatsApp.");
      }
      const target = await resolveSafePath(path);
      const info = await stat(target);
      if (!info.isFile()) throw new Error("Solo se pueden enviar archivos, no carpetas.");
      if (info.size > maxTransferBytes) {
        throw new Error(`El archivo supera el límite de envío de ${formatBytes(maxTransferBytes)}.`);
      }
      await requireApproval(context, `enviar por WhatsApp ${displayPath(target)} (${formatBytes(info.size)})`);
      const buffer = await readFile(target);
      await context.sendFile({
        buffer,
        fileName: basename(target),
        mimetype: mimeTypeFor(target),
        caption,
      });
      return `Archivo enviado por WhatsApp: ${basename(target)}.`;
    },
  };
}

export async function saveIncomingFile({ buffer, fileName, inboxDirectory }) {
  if (!Buffer.isBuffer(buffer)) throw new Error("El adjunto recibido no contiene datos válidos.");
  if (buffer.length > maxTransferBytes) {
    throw new Error(`El archivo supera el límite de recepción de ${formatBytes(maxTransferBytes)}.`);
  }
  await mkdir(inboxDirectory, { recursive: true, mode: 0o700 });
  const canonicalHome = await realpath(homedir());
  const canonicalInbox = await realpath(inboxDirectory);
  await assertInsideRoot(canonicalHome, canonicalInbox);
  const safeName = sanitizeFileName(fileName);
  const target = resolve(canonicalInbox, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`);
  await assertInsideRoot(canonicalHome, target);
  await writeFile(target, buffer, { flag: "wx", mode: 0o600 });
  return target;
}

export function getInboxDirectory() {
  return resolve(homedir(), "HarvisFiles", "inbox");
}

export function isTransferSizeAllowed(size) {
  return Number.isFinite(Number(size)) && Number(size) >= 0 && Number(size) <= maxTransferBytes;
}

export function sanitizeFileName(value) {
  const name = basename(String(value ?? "archivo").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_"))
    .replace(/^\.+$/, "")
    .trim();
  return (name || "archivo").slice(0, 150);
}

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

async function requireApproval(context, action) {
  if (typeof context?.requestApproval !== "function") {
    throw new Error("No hay un canal de autorización disponible; no se realizó ninguna operación.");
  }
  if (!(await context.requestApproval(action))) {
    throw new Error("Operación cancelada o autorización vencida.");
  }
}

async function resolveSafePath(input, { allowMissing = false } = {}) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Indica una ruta de archivo.");
  const root = await realpath(homedir());
  const requestedPath = input.trim();
  const homeRelativePath = requestedPath === "~"
    ? "."
    : requestedPath.replace(/^~[\\/]/, "");
  const target = resolve(root, homeRelativePath);
  await assertInsideRoot(root, target);
  let existing = target;
  while (true) {
    try {
      const resolvedExisting = await realpath(existing);
      await assertInsideRoot(root, resolvedExisting);
      return target;
    } catch (error) {
      if (error.code !== "ENOENT" || existing === root) {
        if (error.code === "ENOENT" && allowMissing) break;
        throw error;
      }
      existing = dirname(existing);
    }
  }
  if (!allowMissing) throw new Error("El archivo no existe.");
  const parent = dirname(target);
  const realParent = await realpath(parent);
  await assertInsideRoot(root, realParent);
  return target;
}

async function assertInsideRoot(root, target) {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const pathDifference = relative(rootPath, targetPath);
  if (pathDifference === ".." || pathDifference.startsWith(`..${sep}`) || isAbsolute(pathDifference)) {
    throw new Error("Por seguridad, Harvis solo puede gestionar archivos dentro de tu carpeta personal.");
  }
}

function displayPath(target) {
  return `~/${relative(homedir(), target).split(sep).join("/")}`;
}

function isImageExtension(extension) {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension);
}

function imageMimeType(extension) {
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  })[extension];
}

function mimeTypeFor(path) {
  return imageMimeType(extname(path).toLowerCase()) ??
    ({
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".csv": "text/csv",
      ".json": "application/json",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function formatBytes(size) {
  return `${(size / (1024 * 1024)).toFixed(size < 1024 * 1024 ? 2 : 1)} MB`;
}

function supportsPdfParserRuntime() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return (major === 20 && minor >= 16) || (major >= 22 && (major > 22 || minor >= 3));
}
