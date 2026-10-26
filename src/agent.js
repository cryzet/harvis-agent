import { readFileSync } from "node:fs";
import { skillInstructions } from "./skills.js";
import { getChatCompletionsUrl } from "./provider-models.js";

const maxToolIterations = 6;
const maxConversationTurns = 12;
const defaultContextWindowTokens = 8192;
const contextSafetyMarginTokens = 512;
const minimumResponseTokens = 256;

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
    const configuredContextWindow = Number(config.provider.contextWindowTokens);
    this.contextWindowTokens = Number.isInteger(configuredContextWindow) &&
      configuredContextWindow >= 1024 && configuredContextWindow <= 1_000_000
      ? configuredContextWindow
      : defaultContextWindowTokens;
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
    let previousTurns = (this.histories.get(sessionId) ?? []).slice(-this.maxHistoryTurns);
    const systemPrompt = typeof this.systemPrompt === "function"
      ? await this.systemPrompt({ input, sessionId, context })
      : this.systemPrompt ?? [
        `Eres ${this.config.name}, un agente personal local.`,
        "Responde en el idioma del usuario. Sé claro y no inventes resultados.",
        "Puedes crear e instalar skills y configurar canales usando las herramientas disponibles.",
        "Pide confirmación antes de instalar paquetes; informa si la instalación debe reiniciarse.",
        "Si el usuario pide buscar información, crear un archivo y enviarlo, hazlo en orden: busca y verifica la información, escribe el archivo, confirma que se guardó y solo entonces envíalo. No llames herramientas que dependan unas de otras en la misma ronda.",
        "La carpeta Documents/<nombre del agente>_WorkDir/config contiene configuración y módulos. Todas las herramientas de archivos usan como raíz Documents/<nombre del agente>_WorkDir/files: escribe rutas relativas a esa raíz (por ejemplo informe.txt, sin anteponer files/). Los adjuntos entrantes están en inbox/whatsapp, inbox/telegram o inbox/discord. Puedes crear notas y archivos allí sin pedir confirmación; usa la misma ruta que write_file devolvió para send_file.",
        "Tu personalidad se define en soul.md y puedes modificarla con write_soul. Instrucciones.txt es exclusivamente para el subbot de atención a clientes; no lo uses como notas ni como directrices propias. Solo léelo o modifícalo si el administrador te lo pide.",
        "Los adjuntos recibidos se leen antes de responder; analiza su contenido junto con el mensaje del usuario.",
        "Las skills son instrucciones Markdown guardadas en el perfil del usuario.",
        `Directrices actuales de soul.md:\n${readSoul(this.paths)}`,
        "Cuando el administrador pida cambiar la información para clientes, lee primero Instrucciones.txt con read_client_instructions; luego escribe el contenido completo revisado con write_client_instructions, preservando la información no relacionada. Guarda los números y datos privados de contactos en contacts.txt, nunca en Instrucciones.txt.",
        "El administrador puede ver y actualizar la lista privada config/contacts.txt mediante read_contacts y write_contacts. Antes de modificarla, léela para conservar los contactos que no se pidieron cambiar. contacts.txt no se comparte con el subbot ni con clientes.",
        "Si el administrador pide enviar o derivar un mensaje por WhatsApp a un contacto guardado, usa read_contacts para identificar la etiqueta y send_contact_message para enviarlo. Si pide escribir a un número de cliente indicado en su solicitud, usa send_whatsapp_message. Envía solo cuando el administrador lo haya solicitado explícitamente; no envíes campañas ni mensajes proactivos por iniciativa propia.",
        "Si están disponibles las herramientas web, úsalas para consultas actuales; cita los enlaces devueltos y no inventes resultados.",
        skillInstructions(this.paths, this.config),
      ].filter(Boolean).join("\n\n");
    const userMessage = await this.createUserMessage(input.trim(), context, sessionId);
    const systemMessage = {
      role: "system",
      content: systemPrompt || "Responde de forma breve y no inventes información.",
    };
    const currentTurn = [userMessage];
    let artifactRetries = 0;
    let nonRepeatableToolHasRun = false;
    let retryWithoutTools = false;

    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      const toolsEnabled = !retryWithoutTools;
      const context = this.fitContext(systemMessage, previousTurns, currentTurn, toolsEnabled);
      previousTurns = context.historyTurns;
      const response = await this.request(context.messages, {
        toolsEnabled,
        maxTokens: context.maxTokens,
      });
      const message = response.choices?.[0]?.message;
      if (!message) throw new Error("El proveedor devolvió una respuesta vacía.");
      if (message.tool_calls?.length && !this.tools.length) {
        throw new Error("Este agente no tiene herramientas habilitadas.");
      }
      currentTurn.push(message);
      if (!message.tool_calls?.length) {
        const rawText = extractText(message.content);
        const text = cleanAssistantText(rawText);
        if (!text && hasOnlyUnusedTokens(rawText) && artifactRetries === 0) {
          artifactRetries += 1;
          retryWithoutTools = nonRepeatableToolHasRun;
          currentTurn.push({
            role: "user",
            content: "La respuesta anterior contenía marcadores internos del modelo. Continúa con una respuesta normal, clara y en español; no repitas esos marcadores.",
          });
          continue;
        }
        if (!text) {
          throw new Error(hasOnlyUnusedTokens(rawText)
            ? "El proveedor volvió a devolver marcadores internos (<unused…>) en vez de una respuesta. Revisa el modelo o su configuración de Chat Completions."
            : "El modelo no generó texto de respuesta.");
        }
        this.remember(currentTurn, sessionId, previousTurns);
        return text;
      }
      if (retryWithoutTools) {
        throw new Error("El proveedor intentó ejecutar herramientas durante la recuperación de una respuesta inválida.");
      }
      for (const toolCall of message.tool_calls) {
        const name = toolCall.function?.name;
        if (["send_file", "send_contact_message", "send_whatsapp_message", "escalate_to_contact", "delete_file", "create_skill", "install_skill", "install_channel"]
          .includes(name)) {
          nonRepeatableToolHasRun = true;
        }
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
        currentTurn.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result?.type === "image"
            ? result.text
            : typeof result === "string" ? result : JSON.stringify(result),
        });
        if (result?.type === "image") {
          currentTurn.push({
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

  fitContext(systemMessage, historyTurns, currentTurn, toolsEnabled) {
    const outputLimit = Math.min(
      Number(this.config.provider.maxTokens) || 1000,
      this.contextWindowTokens - minimumResponseTokens - contextSafetyMarginTokens,
    );
    const promptLimit = this.contextWindowTokens - outputLimit - contextSafetyMarginTokens;
    let retainedTurns = [...historyTurns];
    const tools = toolsEnabled ? this.tools : [];
    const estimate = () => estimatePromptTokens(
      [systemMessage, ...retainedTurns.flat(), ...currentTurn],
      tools,
    );

    while (retainedTurns.length && estimate() > promptLimit) retainedTurns.shift();
    if (estimate() > promptLimit) compactCurrentTurn(currentTurn);

    const messages = [systemMessage, ...retainedTurns.flat(), ...currentTurn];
    const promptTokens = estimatePromptTokens(messages, tools);
    const availableTokens = this.contextWindowTokens - promptTokens - contextSafetyMarginTokens;
    if (availableTokens < minimumResponseTokens) {
      throw new Error(
        `El mensaje actual y las instrucciones ocupan aproximadamente ${promptTokens} tokens; ` +
        `superan el contexto disponible de ${this.contextWindowTokens}. Reduce el tamaño del mensaje o de los adjuntos.`,
      );
    }
    return {
      messages,
      historyTurns: retainedTurns,
      maxTokens: Math.min(outputLimit, availableTokens),
    };
  }

  async request(messages, { toolsEnabled = true, maxTokens } = {}) {
    const { baseUrl, model, apiKey, temperature, name } = this.config.provider;
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
        max_tokens: maxTokens ?? this.config.provider.maxTokens,
        tools: toolsEnabled && this.tools.length ? this.tools : undefined,
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

  remember(messages, sessionId, previousTurns) {
    const safeMessages = messages.map((message) => {
      if (message.role === "assistant" && typeof message.content === "string" &&
          /<unused\d+>/i.test(message.content)) {
        return {
          ...message,
          content: cleanAssistantText(message.content) || "[Respuesta inválida del proveedor omitida.]",
        };
      }
      if (!Array.isArray(message.content) ||
          !message.content.some((part) => part.type === "image_url")) return message;
      return {
        ...message,
        content: "[La imagen se analizó y no se conserva en el historial.]",
      };
    });
    const history = [...previousTurns, safeMessages]
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

function estimatePromptTokens(messages, tools) {
  let serialized = JSON.stringify({ messages, tools });
  const imagePayloads = serialized.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g) ?? [];
  serialized = serialized.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[image payload]");
  return Math.ceil(serialized.length / 3) +
    (messages.length + tools.length) * 8 +
    imagePayloads.length * 1024;
}

function compactCurrentTurn(messages) {
  for (const message of messages) {
    if (message.role === "tool" && typeof message.content === "string" && message.content.length > 1600) {
      message.content = compactText(message.content, 1600);
    }
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      const fn = toolCall.function;
      if (typeof fn?.arguments !== "string" || fn.arguments.length <= 1600) continue;
      try {
        const args = JSON.parse(fn.arguments);
        for (const [key, value] of Object.entries(args)) {
          if (typeof value === "string" && value.length > 1200) {
            args[key] = compactText(value, 1200);
          }
        }
        fn.arguments = JSON.stringify(args);
      } catch {
        fn.arguments = "{}";
      }
    }
  }
}

function compactText(value, maxCharacters) {
  const text = String(value);
  if (text.length <= maxCharacters) return text;
  const firstPart = Math.floor(maxCharacters * 0.7);
  const lastPart = maxCharacters - firstPart;
  return `${text.slice(0, firstPart)}\n[contenido anterior compactado]\n${text.slice(-lastPart)}`;
}

function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function cleanAssistantText(text) {
  return text.replace(/<unused\d+>/gi, "").trim();
}

function hasOnlyUnusedTokens(text) {
  return /<unused\d+>/i.test(text) &&
    text.replace(/<unused\d+>/gi, "").replace(/[\s.,!?;:|]+/g, "").length === 0;
}
