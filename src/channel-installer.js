import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)?$/i;

export async function installChannel(input, { config, paths, save, install = installNpm }) {
  const normalized = input.trim().toLowerCase();
  if (normalized === "@openclaw/whatsapp") {
    throw new Error(
      '@openclaw/whatsapp necesita el host OpenClaw. En Harvis instala "whatsapp", que usa el mismo motor Baileys.',
    );
  }
  const builtIns = {
    whatsapp: {
      packages: ["baileys@7.0.0-rc14", "qrcode-terminal@0.12.0"],
      description: "Baileys para vincular WhatsApp mediante QR",
      message: "Harvis te preguntará si quieres vincularlo ahora con un QR.",
    },
    telegram: {
      packages: ["grammy@1.46.0"],
      description: "grammY para conectar el bot de Telegram",
      message: "Configura el token del bot con /configure channel telegram token <token>.",
    },
    discord: {
      packages: ["discord.js@14.27.0"],
      description: "discord.js para conectar el bot de Discord",
      message: "Configura el token del bot con /configure channel discord token <token>.",
    },
  };
  const builtIn = builtIns[normalized];
  if (builtIn) {
    await install(builtIn.packages, paths.root);
    const type = builtIn.type ?? normalized;
    let channel = config.channels.find((item) => item.type === type);
    if (!channel) {
      channel = { type, enabled: true };
      config.channels.push(channel);
    } else {
      channel.enabled = true;
    }
    save();
    return `Canal ${type} instalado (${builtIn.description}). ${builtIn.message}`;
  }
  if (!packagePattern.test(input)) {
    throw new Error("Indica 'whatsapp' o un nombre npm válido.");
  }
  const name = getPackageName(input);
  const directoryName = name.replace(/^@/, "").replace(/[\\/]/g, "-");
  const installDir = join(paths.channelsDir, directoryName);
  await mkdir(installDir, { recursive: true });
  await install([input], installDir);
  const requireFromChannel = createRequire(join(installDir, "package.json"));
  const modulePath = requireFromChannel.resolve(name);
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.createChannel !== "function") {
    throw new Error(`El paquete ${name} no exporta createChannel(config); no se habilitó como canal.`);
  }
  const channel = config.channels.find((item) => item.module === name);
  const entry = {
    type: channel?.type ?? `plugin-${directoryName}`,
    module: name,
    installDir: directoryName,
    enabled: true,
  };
  if (channel) Object.assign(channel, entry);
  else config.channels.push(entry);
  save();
  return `Paquete ${name} instalado como canal. Debe exportar createChannel(config). Ejecuta /restart para activarlo.`;
}

function getPackageName(spec) {
  if (!spec.startsWith("@")) return spec.split("@")[0];
  const slash = spec.indexOf("/");
  const versionSeparator = spec.indexOf("@", slash + 1);
  return versionSeparator === -1 ? spec : spec.slice(0, versionSeparator);
}

async function installNpm(packageNames, prefix) {
  await mkdir(prefix, { recursive: true });
  try {
    await writeFile(join(prefix, "package.json"), '{"private":true}\n', { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const args = ["install", "--prefix", prefix, "--no-audit", "--no-fund", ...packageNames];
  const command = process.platform === "win32" ? "powershell.exe" : "npm";
  const commandArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `& 'npm.cmd' ${args.map(quotePowerShell).join(" ")}`]
    : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: prefix, windowsHide: true });
    let output = "";
    const collect = (chunk) => {
      output = `${output}${chunk}`;
      process.stdout.write(chunk);
      if (output.length > 5000) output = output.slice(-5000);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`npm agotó el límite de 5 minutos instalando ${packageNames.join(", ")}. ${output.slice(-1000)}`));
    }, 300_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`No se pudo iniciar npm: ${error.message}`, { cause: error }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`npm install falló (${code}): ${output.slice(-1500)}`));
        return;
      }
      resolve();
    });
  });
}

function quotePowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
