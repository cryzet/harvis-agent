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
        "Solo puedes gestionar archivos dentro de Documents/<nombre del agente>_WorkDir. El usuario autenticado como administrador puede operar allí sin aprobaciones OTP por archivo.",
        "Si el usuario pide analizar un adjunto recibido, usa read_file con la ruta informada.",
        "Las skills son instrucciones Markdown guardadas en el perfil del usuario.",
        "Para administrar atención a clientes, consulta o actualiza Instrucciones.txt y administra Ignore.txt con las herramientas correspondientes.",
        "Si están disponibles las herramientas web, úsalas para consultas actuales; cita los enlaces devueltos y no inventes resultados.",
        skillInstructions(this.paths, this.config),
      ].filter(Boolean).join("\n\n");
    const messages = [
      {
        role: "system",
        content: systemPrompt || "Responde de forma breve y no inventes información.",
      },
      ...historyMessages,
      { role: "user", content: input.trim() },
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

function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}
