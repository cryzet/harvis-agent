import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const requireFromProject = createRequire(join(projectRoot, "package.json"));

try {
  await ensureDependencies();
  await ensureSpeechModel();
  if (process.argv.includes("--install-only")) {
    console.log("Instalación de Harvis completada.");
  } else {
    await startAgent();
  }
} catch (error) {
  console.error(`No se pudo preparar Harvis: ${error.message}`);
  process.exitCode = 1;
}

async function ensureDependencies() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) {
    throw new Error(`Harvis requiere Node.js 20 o superior. Versión detectada: ${process.versions.node}.`);
  }

  let missing = getMissingDependencies();
  if (!missing.length) {
    console.log("Dependencias de Harvis instaladas.");
    return;
  }

  console.log(`Instalando dependencias necesarias: ${missing.join(", ")}`);
  await runNpmInstall();
  missing = getMissingDependencies();
  if (missing.length) {
    throw new Error(`La instalación terminó, pero no se encontraron: ${missing.join(", ")}.`);
  }
}

async function ensureSpeechModel() {
  console.log("Comprobando el modelo de transcripción de voz…");
  const { ensureWhisperModel } = await import("./src/speech-recognition.js");
  await ensureWhisperModel({ onProgress: (message) => console.info(message) });
}

function getMissingDependencies() {
  const missing = Object.keys(packageJson.dependencies ?? {}).filter((name) => {
    try {
      requireFromProject.resolve(name);
      return false;
    } catch {
      // Some packages (including the MCP SDK) intentionally expose only
      // subpath exports, so resolving the package root is not supported.
      return !existsSync(join(projectRoot, "node_modules", ...name.split("/")));
    }
  });
  const whisperRuntime = process.platform === "win32" && process.arch === "x64"
    ? "@whisper-cpp-node/win32-x64"
    : process.platform === "darwin" && process.arch === "arm64"
      ? "@whisper-cpp-node/darwin-arm64"
      : null;
  if (whisperRuntime) {
    try {
      requireFromProject.resolve(whisperRuntime);
    } catch {
      missing.push(whisperRuntime);
    }
  }
  return missing;
}

function runNpmInstall() {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(
      windows ? (process.env.ComSpec ?? "cmd.exe") : "npm",
      windows ? ["/d", "/s", "/c", "npm install"] : ["install"],
      {
      cwd: projectRoot,
      stdio: "inherit",
      windowsHide: true,
      },
    );
    child.once("error", (error) => reject(new Error(
      `No se pudo ejecutar npm install. Comprueba que npm esté instalado y disponible en PATH: ${error.message}`,
      { cause: error },
    )));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install terminó con código ${code ?? "desconocido"}.`));
    });
  });
}

function startAgent() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(projectRoot, "index.js")], {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", (error) => reject(new Error(
      `No se pudo iniciar el agente: ${error.message}`,
      { cause: error },
    )));
    child.once("close", (code, signal) => {
      if (signal) {
        process.exitCode = 1;
        resolve();
        return;
      }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
