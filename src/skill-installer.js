import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeSkillName } from "./skills.js";

const timeoutMs = 300_000;

export async function installSkillPackage(
  packageSpec,
  { paths, config, save, confirmInstall, install = runNpmInstall },
) {
  const spec = validatePackageSpec(packageSpec);
  if (typeof confirmInstall !== "function" || !(await confirmInstall(spec))) {
    throw new Error(`Se canceló la instalación de la skill ${spec}.`);
  }
  const staging = await mkdtemp(join(paths.root, ".skill-install-"));
  try {
    await writeFilePackageManifest(staging);
    const output = await install(spec, staging);
    const skillFile = await findSkillFile(join(staging, "node_modules"));
    if (!skillFile) {
      throw new Error(`El paquete ${spec} se instaló, pero no contiene SKILL.md.`);
    }
    const skillName = normalizeSkillName(getPackageName(spec).split("/").at(-1));
    const target = join(paths.skillsDir, skillName);
    await mkdir(target, { recursive: false, mode: 0o700 });
    await copyFile(skillFile, join(target, "SKILL.md"));
    config.skills[skillName] = true;
    save();
    return `Skill "${skillName}" instalada y habilitada. Reinicia para cargarla.\n${output.slice(-1000)}`;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function validatePackageSpec(value) {
  if (typeof value !== "string" ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)?$/i.test(value)) {
    throw new Error("Indica un nombre npm válido (opcionalmente con versión exacta).");
  }
  return value;
}

function getPackageName(spec) {
  if (!spec.startsWith("@")) return spec.split("@")[0];
  const slash = spec.indexOf("/");
  const versionSeparator = spec.indexOf("@", slash + 1);
  return versionSeparator === -1 ? spec : spec.slice(0, versionSeparator);
}

async function writeFilePackageManifest(directory) {
  await writeFile(join(directory, "package.json"), '{"private":true}\n', "utf8");
}

async function findSkillFile(modulesDir) {
  const entries = await readdir(modulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      const scoped = await findSkillFile(join(modulesDir, entry.name));
      if (scoped) return scoped;
      continue;
    }
    if (!entry.isDirectory()) continue;
    for (const candidate of [join(modulesDir, entry.name, "SKILL.md"), join(modulesDir, entry.name, "skills", "SKILL.md")]) {
      try {
        if ((await stat(candidate)).isFile()) return await realpath(candidate);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return null;
}

function runNpmInstall(packageSpec, staging) {
  const npmArgs = ["install", "--prefix", staging, "--no-audit", "--no-fund", packageSpec];
  const command = process.platform === "win32" ? "powershell.exe" : "npm";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `& 'npm.cmd' ${npmArgs.map(quotePowerShell).join(" ")}`]
    : npmArgs;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: staging, windowsHide: true });
    let output = "";
    const record = (chunk) => { output = `${output}${chunk}`.slice(-5000); };
    child.stdout.setEncoding("utf8").on("data", record);
    child.stderr.setEncoding("utf8").on("data", record);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`npm tardó más de ${timeoutMs / 1000} segundos instalando ${packageSpec}.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`No se pudo ejecutar npm: ${error.message}`, { cause: error }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`npm falló instalando ${packageSpec}: ${output.slice(-1500)}`));
        return;
      }
      resolve(output);
    });
  });
}

function quotePowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
