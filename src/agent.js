import { readFileSync } from "node:fs";
import { skillInstructions } from "./skills.js";
import { getChatCompletionsUrl } from "./provider-models.js";

const maxToolIterations = 5;
const maxConversationTurns = 12;

export class Agent {
  constructor({
    config,
    paths,
    handlers,
    tools,
    systemPrompt,
    maxHistoryTurns = maxConversationTurns,
  }) {
    this.config = config;
    this.paths = paths;
    this.handlers = handlers;
    this.tools = tools;
    this.systemPrompt = systemPrompt;
    this.maxHistoryTurns = maxHistoryTurns;
    this.histories = new Map();
    this.replyQueues = new Map();
  }

  reply(input, sessionId = "console", context = {}) {
    const previous = this.replyQueues.get(sessionId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.runReply(input, sessionId, context));
    this.replyQueues.set(sessionId, pending);
    return pending.finally(() => {
      if (this.replyQueues.get(sessionId) === pending) {
        this.replyQueues.delete(sessionId);
      }
    });
  }

  async runReply(input, sessionId, context) {
    if (typeof input !== "string" || !input.trim()) {
      throw new Error("Escribe un mensaje antes de enviarlo.");
    }
    const previousTurns = this.histories.get(sessionId) ?? [];
    const historyMessages = previousTurns.flat();
    const systemPrompt = typeof this.systemPrompt === "function"
      ? await this.systemPrompt({ input, sessionId, context })
      : this.systemPrompt ?? [
        `Eres ${this.config.name}, un agente personal local.`,
        "Responde en el idioma del usuario. Sé claro y no inventes resultados.",
        "Puedes crear e instalar skills y configurar canales usando las herramientas disponibles.",
        "Pide confirmación antes de instalar paquetes; informa si la instalación debe reiniciarse.",
        "La carpeta Documents/<nombre del agente>_WorkDir/config contiene configuración y módulos. La carpeta files contiene tus notas, documentos del usuario y WhatsApp-Inbox. Puedes crear notas y archivos allí sin pedir confirmación.",
        "Tu personalidad se define en soul.md y puedes modificarla con write_soul. Instrucciones.txt es exclusivamente para el subbot de atención a clientes; no lo uses como notas ni como directrices propias. Solo léelo o modifícalo si el administrador te lo pide.",
        "Los adjuntos recibidos se leen antes de responder; analiza su contenido junto con el mensaje del usuario.",
        "Las skills son instrucciones Markdown guardadas en el perfil del usuario.",
        `Directrices actuales de soul.md:\n${readSoul(this.paths)}`,
        "Cuando el administrador pida cambiar la información para clientes, lee primero Instrucciones.txt con read_client_instructions; luego escribe el contenido completo revisado con write_client_instructions, preservando la información no relacionada. Nunca dejes Instrucciones.txt vacío.",
        "Si están disponibles las herramientas web, úsalas para consultas actuales; cita los enlaces devueltos y no inventes resultados.",
        skillInstructions(this.paths, this.config),
      ].filter(Boolean).join("\n\n");
    const userMessage = await this.createUserMessage(input.trim(), context, sessionId);
    const messages = [
      {
        role: "system",
        content: systemPrompt || "Responde de forma breve y no inventes información.",
      },
      ...historyMessages,
      userMessage,
    ];
    const turnStart = messages.length - 1;

    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      const response = await this.request(messages);
      const message = response.choices?.[0]?.message;
      if (!message) throw new Error("El proveedor devolvió una respuesta vacía.");
      if (message.tool_calls?.length && !this.tools.length) {
        throw new Error("Este agente no tiene herramientas habilitadas.");
      }
      messages.push(message);
      if (!message.tool_calls?.length) {
        const text = extractText(message.content);
        if (!text) throw new Error("El modelo no generó texto de respuesta.");
        this.remember(messages, sessionId, turnStart);
        return text;
      }
      for (const toolCall of message.tool_calls) {
        const name = toolCall.function?.name;
        const handler = this.handlers[name];
        let result;
        try {
          if (!handler) throw new Error(`Herramienta desconocida: ${name}`);
          result = await handler(JSON.parse(toolCall.function.arguments || "{}"), {
            ...context,
            sessionId,
          });
        } catch (error) {
          result = `Error: ${error.message}`;
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result?.type === "image"
            ? result.text
            : typeof result === "string" ? result : JSON.stringify(result),
        });
        if (result?.type === "image") {
          messages.push({
            role: "user",
            content: [
              { type: "text", text: "Imagen autorizada para analizar:" },
              {
                type: "image_url",
                image_url: { url: `data:${result.mimetype};base64,${result.data}` },
              },
            ],
          });
        }
      }
    }
    throw new Error(`El modelo excedió ${maxToolIterations} ciclos de herramientas.`);
  }

  async createUserMessage(input, context, sessionId) {
    const attachment = context.attachment;
    if (!attachment) return { role: "user", content: input };
    if (typeof attachment.path !== "string" || !attachment.path) {
      throw new Error("La ruta del archivo adjunto no es válida.");
    }
    const readFile = this.handlers.read_file;
    if (typeof readFile !== "function") {
      throw new Error("No hay una herramienta disponible para leer el archivo adjunto.");
    }
    const result = await readFile({ path: attachment.path }, { ...context, sessionId });
    if (result?.type === "image") {
      return {
        role: "user",
        content: [
          { type: "text", text: [input, `Imagen adjunta: ${attachment.fileName ?? attachment.path}.`].filter(Boolean).join("\n") },
          {
            type: "image_url",
            image_url: { url: `data:${result.mimetype};base64,${result.data}` },
          },
        ],
      };
    }
    if (typeof result !== "string") {
      throw new Error("No se pudo interpretar el contenido del archivo adjunto.");
    }
    return {
      role: "user",
      content: [
        input,
        `Contenido del archivo adjunto (${attachment.fileName ?? attachment.path}):`,
        result,
      ].filter(Boolean).join("\n\n"),
    };
  }

  async request(messages) {
    const { baseUrl, model, apiKey, temperature, maxTokens, name } = this.config.provider;
    if (!model.trim()) {
      throw new Error("No hay un modelo configurado. Usa /configure provider model <id>.");
    }
    const response = await fetch(getChatCompletionsUrl({
      baseUrl,
      providerName: name,
    }), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        tools: this.tools.length ? this.tools : undefined,
      }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) {
      const body = await response.text();
      if (/no models loaded/i.test(body)) {
        throw new Error("LM Studio no tiene un modelo cargado. Cárgalo en Developer y revisa /configure.");
      }
      throw new Error(`Error del proveedor (${response.status}): ${body.slice(0, 1000)}`);
    }
    return response.json();
  }

  remember(messages, sessionId, turnStart) {
    const safeMessages = messages.slice(turnStart).map((message) => {
      if (!Array.isArray(message.content) ||
          !message.content.some((part) => part.type === "image_url")) return message;
      return {
        ...message,
        content: "[La imagen se analizó y no se conserva en el historial.]",
      };
    });
    const history = [...(this.histories.get(sessionId) ?? []), safeMessages]
      .slice(-this.maxHistoryTurns);
    this.histories.delete(sessionId);
    this.histories.set(sessionId, history);
    while (this.histories.size > 50) {
      this.histories.delete(this.histories.keys().next().value);
    }
  }
}

function readSoul(paths) {
  try { return readFileSync(paths.soulFile, "utf8").trim(); }
  catch { return "Eres un asistente personal local, útil y claro."; }
}

function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}
