import { skillInstructions } from "./skills.js";
import { getChatCompletionsUrl } from "./provider-models.js";

const maxToolIterations = 5;
const maxConversationTurns = 12;

export class Agent {
  constructor({ config, paths, handlers, tools }) {
    this.config = config;
    this.paths = paths;
    this.handlers = handlers;
    this.tools = tools;
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
    const messages = [
      {
        role: "system",
        content: [
          `Eres ${this.config.name}, un agente personal local.`,
          "Responde en el idioma del usuario. Sé claro y no inventes resultados.",
          "Puedes crear e instalar skills y configurar canales usando las herramientas disponibles.",
          "Pide confirmación antes de instalar paquetes; informa si la instalación debe reiniciarse.",
          "Las operaciones de archivos se limitan a la carpeta personal y requieren autorización explícita antes de cada acción.",
          "Si el usuario pide analizar un adjunto recibido, usa read_file con la ruta informada; esa herramienta pedirá autorización antes de leerlo.",
          "Las skills son instrucciones Markdown guardadas en el perfil del usuario.",
          "Si están disponibles las herramientas web, úsalas para consultas actuales; cita los enlaces devueltos y no inventes resultados.",
          skillInstructions(this.paths, this.config),
        ].filter(Boolean).join("\n\n"),
      },
      ...(this.histories.get(sessionId) ?? []).flat(),
      { role: "user", content: input.trim() },
    ];

    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      const response = await this.request(messages);
      const message = response.choices?.[0]?.message;
      if (!message) throw new Error("El proveedor devolvió una respuesta vacía.");
      messages.push(message);
      if (!message.tool_calls?.length) {
        const text = extractText(message.content);
        if (!text) throw new Error("El modelo no generó texto de respuesta.");
        this.remember(messages, sessionId);
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
      signal: AbortSignal.timeout(180_000),
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

  remember(messages, sessionId) {
    const safeMessages = messages.slice(1).map((message) => {
      if (!Array.isArray(message.content) ||
          !message.content.some((part) => part.type === "image_url")) return message;
      return {
        ...message,
        content: "[La imagen se analizó y no se conserva en el historial.]",
      };
    });
    const history = [...(this.histories.get(sessionId) ?? []), safeMessages]
      .slice(-maxConversationTurns);
    this.histories.delete(sessionId);
    this.histories.set(sessionId, history);
    while (this.histories.size > 50) {
      this.histories.delete(this.histories.keys().next().value);
    }
  }
}

function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}
