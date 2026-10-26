import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, getPaths, saveConfig as persistConfig } from "./config.js";
import { join } from "node:path";
import { createSkill, listSkills, setSkillEnabled } from "./skills.js";
import { scrapeWebPage, searchWeb } from "./web-tools.js";

const paths = getPaths();
if (!existsSync(paths.configFile) && !existsSync(join(paths.legacyRoot, "config.json"))) {
  throw new Error("Harvis aún no está configurado. Ejecuta npm start para elegir el nombre y completar la configuración inicial.");
}
const config = loadConfig(paths);
if (!config.mcp.enabled) {
  throw new Error("El servidor MCP local está deshabilitado. Habilítalo con /configure > MCP local.");
}
const definitions = [
  {
    name: "harvis_status",
    description: "Devuelve el nombre, proveedor y estado resumido de Harvis.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_channels",
    description: "Lista los canales configurados y si están habilitados.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_skills",
    description: "Lista las skills instaladas y su estado.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_skill",
    description: "Crea una skill local con instrucciones Markdown en el perfil de Harvis.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre corto de la skill." },
        description: { type: "string", description: "Descripción opcional." },
        instructions: { type: "string", description: "Contenido Markdown de SKILL.md." },
      },
      required: ["name", "instructions"],
      additionalProperties: false,
    },
  },
  {
    name: "set_skill_enabled",
    description: "Habilita o deshabilita una skill instalada.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, enabled: { type: "boolean" } },
      required: ["name", "enabled"],
      additionalProperties: false,
    },
  },
  {
    name: "set_channel_enabled",
    description: "Habilita o deshabilita un canal configurado, excepto la consola.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, enabled: { type: "boolean" } },
      required: ["name", "enabled"],
      additionalProperties: false,
    },
  },
  ...(config.web.searchEnabled ? [{
    name: "web_search",
    description: "Busca información pública actual en la web.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Consulta de búsqueda." },
        count: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  }] : []),
  ...(config.web.scrapeEnabled ? [{
    name: "web_scrape",
    description: "Extrae texto de una página pública HTTP(S), bloqueando redes privadas.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL pública de la página." } },
      required: ["url"],
      additionalProperties: false,
    },
  }] : []),
];

const handlers = {
  harvis_status: () => ({
    name: config.name,
    provider: config.provider.baseUrl,
    model: config.provider.model || "no configurado",
  }),
  list_channels: () => config.channels.map(({ type, enabled }) => ({
    type,
    enabled: enabled !== false,
  })),
  list_skills: () => listSkills(paths, config),
  create_skill: (args) => {
    const result = createSkill(args, paths, config);
    save();
    return result;
  },
  set_skill_enabled: ({ name, enabled }) => {
    const result = setSkillEnabled(name, enabled, paths, config, save);
    return result;
  },
  set_channel_enabled: ({ name, enabled }) => {
    const channel = config.channels.find((item) => item.type === name);
    if (!channel) throw new Error(`El canal "${name}" no está configurado.`);
    if (name === "console" && !enabled) throw new Error("La consola no se puede deshabilitar.");
    channel.enabled = enabled;
    save();
    return `Canal "${name}" ${enabled ? "habilitado" : "deshabilitado"}.`;
  },
  ...(config.web.searchEnabled ? {
    web_search: ({ query, count }) => searchWeb(query, config, { count }),
  } : {}),
  ...(config.web.scrapeEnabled ? {
    web_scrape: ({ url }) => scrapeWebPage(url),
  } : {}),
};

function save() {
  persistConfig(config, paths);
}

const server = new Server(
  { name: "harvis-lite", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const handler = handlers[params.name];
  if (!handler) {
    return { isError: true, content: [{ type: "text", text: `Herramienta desconocida: ${params.name}` }] };
  }
  try {
    const result = await handler(params.arguments ?? {});
    return {
      content: [{
        type: "text",
        text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
      }],
    };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
const shutdown = async () => {
  try {
    await server.close();
  } catch (error) {
    console.error(`No se pudo cerrar el servidor MCP: ${error.message}`);
    process.exitCode = 1;
  }
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.stdin.once("end", () => void shutdown());
process.stdin.once("error", (error) => {
  console.error(`Error en stdin MCP: ${error.message}`);
  process.exitCode = 1;
});
