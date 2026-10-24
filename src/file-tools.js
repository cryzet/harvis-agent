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
  changeIgnoredNumber,
  getConfiguredAdminNumbers,
  readCustomerInstructions,
  readIgnoredNumbers,
  updateCustomerInstructions,
} from "./client-access.js";
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

export function getAgentWorkDirectory(name, home = homedir()) {
  const safeName = String(name || "Harvis")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 80) || "Harvis";
  return resolve(home, "Documents", `${safeName}_WorkDir`);
}

export async function prepareWorkDirectory(name) {
  const target = getAgentWorkDirectory(name);
  const documents = resolve(homedir(), "Documents");
  await mkdir(documents, { recursive: true, mode: 0o700 });
  await mkdir(target, { recursive: true, mode: 0o700 });
  const [realDocuments, realTarget] = await Promise.all([realpath(documents), realpath(target)]);
  assertInsideRoot(realDocuments, realTarget);
  return realTarget;
}

export const fileToolDefinitions = [
  tool("list_files", "Lista archivos y carpetas dentro de Documents/<nombre>_WorkDir. Disponible solo para el administrador autenticado.", {
    path: { type: "string", description: "Ruta relativa al directorio de trabajo; por defecto, la raíz." },
  }),
  tool("read_file", "Lee un archivo de texto, documento o imagen dentro del directorio de trabajo. Disponible solo para el administrador autenticado.", {
    path: { type: "string", description: "Ruta relativa o absoluta dentro de Documents/<nombre>_WorkDir." },
  }, ["path"]),
  tool("write_file", "Crea o reemplaza un archivo dentro del directorio de trabajo. Disponible solo para el administrador autenticado.", {
    path: { type: "string", description: "Ruta relativa o absoluta dentro de Documents/<nombre>_WorkDir; la carpeta debe existir." },
    content: { type: "string", description: "Contenido de texto que se guardará." },
  }, ["path", "content"]),
  tool("delete_file", "Elimina un archivo (no una carpeta) dentro del directorio de trabajo. Disponible solo para el administrador autenticado.", {
    path: { type: "string", description: "Ruta relativa o absoluta dentro de Documents/<nombre>_WorkDir." },
  }, ["path"]),
  tool("send_file", "Envía por WhatsApp un archivo del directorio de trabajo al administrador autenticado, sin OTP.", {
    path: { type: "string", description: "Ruta relativa o absoluta dentro de Documents/<nombre>_WorkDir." },
    caption: { type: "string", description: "Texto opcional que acompaña al archivo." },
  }, ["path"]),
  tool("manage_ignored_number", "Administra números de WhatsApp excluidos de las respuestas a clientes. Solo administrador.", {
    action: { type: "string", enum: ["list", "add", "remove"] },
    number: { type: "string", description: "Número internacional E.164. No se requiere para listar." },
  }, ["action"]),
  tool("read_client_instructions", "Lee Instrucciones.txt, la única fuente de información para responder a clientes. Solo administrador.", {}),
  tool("write_client_instructions", "Actualiza Instrucciones.txt, la fuente de información del subagente de clientes. Solo administrador.", {
    content: { type: "string", description: "Información segura para compartir con clientes." },
  }, ["content"]),
];

export function createFileToolHandlers({
  config,
  paths,
  workDirectory = prepareWorkDirectory,
} = {}) {
  if (!config?.name || !paths?.instructionsFile || !paths?.ignoreFile) {
    throw new Error("Se requiere la configuración del agente y las rutas de perfil para las herramientas.");
  }
  return {
    list_files: async ({ path = "." } = {}, context) => {
      requireAdmin(context);
      const root = await workDirectory(config.name);
      const target = await resolveSafePath(path, root);
      const entries = await readdir(target, { withFileTypes: true });
      return entries.slice(0, 200).map((entry) =>
        `${entry.isDirectory() ? "[carpeta]" : "[archivo]"} ${entry.name}`,
      ).join("\n") || "La carpeta está vacía.";
    },
    read_file: async ({ path }, context) => {
      requireAdmin(context);
      const root = await workDirectory(config.name);
      const target = await resolveSafePath(path, root);
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
      requireAdmin(context);
      if (typeof content !== "string") throw new Error("El contenido debe ser texto.");
      if (Buffer.byteLength(content) > maxTextBytes) {
        throw new Error("El contenido supera el límite de escritura de 1 MB.");
      }
      const root = await workDirectory(config.name);
      const target = await resolveSafePath(path, root, { allowMissing: true });
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
      requireAdmin(context);
      const root = await workDirectory(config.name);
      const target = await resolveSafePath(path, root);
      if (!(await stat(target)).isFile()) throw new Error("Solo se pueden eliminar archivos, no carpetas.");
      await unlink(target);
      return `Archivo eliminado: ${displayPath(target)}.`;
    },
    send_file: async ({ path, caption = "" }, context) => {
      requireAdmin(context);
      if (typeof context?.sendFile !== "function") {
        throw new Error("El envío de archivos solo está disponible en una conversación de WhatsApp.");
      }
      const root = await workDirectory(config.name);
      const target = await resolveSafePath(path, root);
      const info = await stat(target);
      if (!info.isFile()) throw new Error("Solo se pueden enviar archivos, no carpetas.");
      if (info.size > maxTransferBytes) {
        throw new Error(`El archivo supera el límite de envío de ${formatBytes(maxTransferBytes)}.`);
      }
      const buffer = await readFile(target);
      await context.sendFile({
        buffer,
        fileName: basename(target),
        mimetype: mimeTypeFor(target),
        caption,
      });
      return `Archivo enviado por WhatsApp: ${basename(target)}.`;
    },
    manage_ignored_number: async ({ action, number }, context) => {
      requireAdmin(context);
      if (action === "list") {
        const ignored = await readIgnoredNumbers(paths);
        return ignored.length ? ignored.join("\n") : "Ignore.txt no contiene números.";
      }
      return changeIgnoredNumber(paths, number, action, getConfiguredAdminNumbers(config));
    },
    read_client_instructions: async (_args, context) => {
      requireAdmin(context);
      return (await readCustomerInstructions(paths)) || "Instrucciones.txt está vacío.";
    },
    write_client_instructions: async ({ content }, context) => {
      requireAdmin(context);
      return updateCustomerInstructions(paths, content);
    },
  };
}

export async function saveIncomingFile({ buffer, fileName, workDir }) {
  if (!Buffer.isBuffer(buffer)) throw new Error("El adjunto recibido no contiene datos válidos.");
  if (buffer.length > maxTransferBytes) {
    throw new Error(`El archivo supera el límite de recepción de ${formatBytes(maxTransferBytes)}.`);
  }
  const inboxDirectory = resolve(workDir, "WhatsApp-Inbox");
  await mkdir(inboxDirectory, { recursive: true, mode: 0o700 });
  const documents = await realpath(resolve(homedir(), "Documents"));
  const canonicalHome = await realpath(workDir);
  await assertInsideRoot(documents, canonicalHome);
  const canonicalInbox = await realpath(inboxDirectory);
  assertInsideRoot(canonicalHome, canonicalInbox);
  const safeName = sanitizeFileName(fileName);
  const target = resolve(canonicalInbox, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`);
  assertInsideRoot(canonicalHome, target);
  await writeFile(target, buffer, { flag: "wx", mode: 0o600 });
  return target;
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

function requireAdmin(context) {
  if (context?.role !== "admin") {
    throw new Error("Esta operación está disponible únicamente para el administrador autenticado.");
  }
}

async function resolveSafePath(input, workRoot, { allowMissing = false } = {}) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Indica una ruta de archivo.");
  const root = await realpath(workRoot);
  const requestedPath = input.trim();
  const target = requestedPath === "~"
    ? root
    : requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
      ? resolve(homedir(), requestedPath.slice(2))
      : isAbsolute(requestedPath)
        ? resolve(requestedPath)
        : resolve(root, requestedPath);
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
    throw new Error("Por seguridad, Harvis solo puede gestionar archivos dentro de Documents/<nombre>_WorkDir.");
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
