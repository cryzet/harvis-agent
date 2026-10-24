import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const skillNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function listSkills(paths, config) {
  return readdirSync(paths.skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(paths.skillsDir, entry.name, "SKILL.md")))
    .map((entry) => ({
      name: entry.name,
      enabled: config.skills[entry.name] !== false,
    }));
}

export function createSkill({ name, description = "", instructions }, paths, config) {
  const normalizedName = normalizeSkillName(name);
  if (typeof instructions !== "string" || !instructions.trim()) {
    throw new Error("Las instrucciones de la skill no pueden estar vacías.");
  }
  const skillDir = join(paths.skillsDir, normalizedName);
  if (existsSync(skillDir)) throw new Error(`La skill "${normalizedName}" ya existe.`);
  mkdirSync(skillDir, { recursive: false, mode: 0o700 });
  const metadata = description.trim()
    ? `---\nname: ${normalizedName}\ndescription: ${description.trim()}\n---\n\n`
    : "";
  writeFileSync(join(skillDir, "SKILL.md"), `${metadata}${instructions.trim()}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  config.skills[normalizedName] = true;
  return `Skill "${normalizedName}" creada y habilitada. Se cargará al reiniciar el agente.`;
}

export function setSkillEnabled(name, enabled, paths, config, save) {
  const skillName = normalizeSkillName(name);
  if (!existsSync(join(paths.skillsDir, skillName, "SKILL.md"))) {
    throw new Error(`La skill "${skillName}" no está instalada.`);
  }
  config.skills[skillName] = enabled;
  save();
  return `Skill "${skillName}" ${enabled ? "habilitada" : "deshabilitada"}.`;
}

export function skillInstructions(paths, config, maxChars = 12000) {
  let budget = maxChars;
  const loaded = [];
  for (const skill of listSkills(paths, config).filter((item) => item.enabled).slice(0, 8)) {
    if (budget <= 0) break;
    const text = readFileSync(join(paths.skillsDir, skill.name, "SKILL.md"), "utf8").trim();
    const excerpt = text.slice(0, budget);
    loaded.push(`## Skill: ${skill.name}\n${excerpt}`);
    budget -= excerpt.length;
  }
  return loaded.join("\n\n");
}

export function normalizeSkillName(input) {
  if (typeof input !== "string") throw new Error("El nombre de la skill debe ser texto.");
  const name = input.trim().toLowerCase();
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("El nombre de la skill no puede contener rutas.");
  }
  if (!skillNamePattern.test(name)) {
    throw new Error("Usa un nombre de skill con letras minúsculas, números, guiones o guiones bajos.");
  }
  return name;
}

export function copySkillFile(source, destination) {
  copyFileSync(source, destination, 1);
}
