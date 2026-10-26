import { spawn, execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(new URL("./service-worker.js", import.meta.url));

export async function getServiceStatus(paths) {
  const state = readServiceState(paths);
  if (!state) return { running: false };
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/status`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return { running: false };
    return { running: true, ...(await response.json()) };
  } catch {
    return { running: false };
  }
}

export async function getPendingApprovals(paths) {
  const status = await getServiceStatus(paths);
  return status.running ? status.pendingApprovals ?? [] : [];
}

export async function decideWhatsAppPairing(paths, code, decision) {
  if (!/^\d{6}$/.test(code) || !["approve", "reject"].includes(decision)) {
    throw new Error("Indica un código de seis dígitos y una decisión válida.");
  }
  const state = readServiceState(paths);
  if (!state) throw new Error("El servicio Harvis no está activo.");
  let response;
  try {
    response = await fetch(
      `http://127.0.0.1:${state.port}/pairing/${decision}/${code}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${state.token}` },
        signal: AbortSignal.timeout(3000),
      },
    );
  } catch (error) {
    throw new Error(`No se pudo contactar al servicio Harvis: ${error.message}`);
  }
  const message = await response.text();
  if (!response.ok) {
    throw new Error(message || `El servicio Harvis respondió HTTP ${response.status}.`);
  }
  return message;
}

export async function startService(paths, { registerAutostart = true } = {}) {
  if (registerAutostart) {
    try {
      await registerAutostartService(paths);
    } catch (error) {
      const registrationError = new Error(
        `No se pudo registrar el inicio automático de Harvis: ${error.message}`,
        { cause: error },
      );
      registrationError.code = "HARVIS_AUTOSTART_FAILED";
      throw registrationError;
    }
  }
  const existing = await getServiceStatus(paths);
  if (existing.running) {
    await waitUntilReady(paths, 30_000);
    return "El servicio ya está en ejecución.";
  }

  mkdirSync(dirname(paths.serviceLogFile), { recursive: true, mode: 0o700 });
  const serviceHome = paths.workRoot ?? paths.root;
  const child = spawn(process.execPath, [workerPath, "--home", serviceHome], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, HARVIS_HOME: serviceHome },
  });
  child.unref();
  child.once("error", (error) => {
    console.error(`No se pudo iniciar el servicio Harvis: ${error.message}`);
  });

  await waitUntilReady(paths, 30_000);
  return "Servicio iniciado en segundo plano.";
}

export async function stopService(paths) {
  const state = readServiceState(paths);
  if (!state) return "No hay un servicio Harvis activo.";
  if (!(await getServiceStatus(paths)).running) {
    if (!existsSync(paths.serviceLockFile)) {
      try { unlinkSync(paths.serviceStateFile); } catch (error) {
        if (error.code !== "ENOENT") {
          throw new Error(`No se pudo limpiar el estado obsoleto del servicio: ${error.message}`);
        }
      }
    }
    return "No hay un servicio Harvis activo.";
  }
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${state.port}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    throw new Error(`No se pudo contactar al servicio Harvis: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`El servicio Harvis respondió HTTP ${response.status} al detenerse.`);
  }
  await response.text();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await getServiceStatus(paths)).running && !existsSync(paths.serviceLockFile)) {
      return "Servicio detenido. El inicio automático sigue habilitado.";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("El servicio recibió la orden de detenerse, pero sigue respondiendo.");
}

async function registerAutostartService(paths) {
  if (process.platform === "win32") {
    try {
      await execFileAsync("schtasks.exe", ["/Query", "/TN", "HarvisLite"], {
        windowsHide: true,
      });
      return;
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`No se encontró schtasks.exe: ${error.message}`);
      }
    }
    try {
      const scripts = buildWindowsAutostartScripts({
        nodePath: process.execPath,
        workerPath,
        homePath: paths.workRoot ?? paths.root,
        userName: `${process.env.USERDOMAIN || "."}\\${process.env.USERNAME}`,
      });
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(scripts.outer, "utf16le").toString("base64"),
      ], { windowsHide: false, timeout: 120_000 });
    } catch (error) {
      const detail = error.killed
        ? "se agotó el tiempo de espera para autorizar o registrar la tarea."
        : error.message;
      throw new Error(
        `No se pudo registrar Harvis en el Programador de tareas de Windows. ` +
        `Acepta la solicitud UAC para registrar una tarea de inicio solo para tu usuario. ${detail}`,
      );
    }
    return;
  }
  if (process.platform === "linux") {
    const unitDirectory = join(
      process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config"),
      "systemd",
      "user",
    );
    if (!process.env.HOME && !process.env.XDG_CONFIG_HOME) {
      throw new Error("No se pudo determinar el directorio personal para el servicio systemd de usuario.");
    }
    mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
    const unitFile = join(unitDirectory, "harvis-lite.service");
    writeFileSync(unitFile, [
      "[Unit]",
      "Description=Harvis Lite local assistant",
      "After=default.target",
      "",
      "[Service]",
      "Type=simple",
      `Environment=${systemdQuote(`HARVIS_HOME=${paths.workRoot ?? paths.root}`)}`,
      `ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(workerPath)}`,
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    try {
      await execFileAsync("systemctl", ["--user", "daemon-reload"]);
      await execFileAsync("systemctl", ["--user", "enable", "harvis-lite.service"]);
    } catch (error) {
      throw new Error(`No se pudo habilitar el servicio systemd de usuario: ${error.message}`);
    }
    return;
  }
  throw new Error(`El inicio automático no está implementado para ${process.platform}.`);
}

export function buildWindowsAutostartScripts({ nodePath, workerPath, homePath, userName }) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const actionArguments = `"${workerPath}" --home "${homePath}"`;
  const taskScript = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $identity = ${quote(userName)}`,
    `  $action = New-ScheduledTaskAction -Execute ${quote(nodePath)} -Argument ${quote(actionArguments)}`,
    "  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity",
    "  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited",
    "  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew",
    "  Register-ScheduledTask -TaskName 'HarvisLite' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
  const encodedTask = Buffer.from(taskScript, "utf16le").toString("base64");
  const outer = [
    "try {",
    `  $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-EncodedCommand', '${encodedTask}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    "  if ($process.ExitCode -ne 0) { exit $process.ExitCode }",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
  return { outer, taskScript };
}

function readServiceState(paths) {
  try {
    return JSON.parse(readFileSync(paths.serviceStateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw new Error(`No se pudo leer el estado del servicio: ${error.message}`);
  }
}

async function waitUntilReady(paths, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await getServiceStatus(paths);
    if (status.running && status.ready) return status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `El servicio no confirmó que sus canales estuvieran listos en ${timeout / 1000} segundos. ` +
    `Revisa el registro ${paths.serviceLogFile}.`,
  );
}

function systemdQuote(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
