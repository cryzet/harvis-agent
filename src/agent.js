import { readFileSync } from "node:fs";
import { skillInstructions } from "./skills.js";
import { getChatCompletionsUrl } from "./provider-models.js";

const maxToolIterations = 6;
const maxEmptyResponseRetries = 2;
const maxConversationTurns = 12;
const defaultContextWindowTokens = 32768;
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
    this.memoryGeneration = 0;
  }

  reply(input, sessionId = "console", context = {}) {
    const memoryGeneration = this.memoryGeneration;
    const previous = this.replyQueues.get(sessionId) ?? Promise.resolve();
    const pending = previous.catch(() => {})
      .then(() => this.runReply(input, sessionId, context, memoryGeneration));
    this.replyQueues.set(sessionId, pending);
    return pending.finally(() => {
      if (this.replyQueues.get(sessionId) === pending) {
        this.replyQueues.delete(sessionId);
      }
    });
  }

  async runReply(input, sessionId, context, memoryGeneration = this.memoryGeneration) {
    if (typeof input !== "string" || !input.trim()) {
      throw new Error("Escribe un mensaje antes de enviarlo.");
    }
    let previousTurns = (this.histories.get(sessionId) ?? []).slice(-this.maxHistoryTurns);
    const systemPrompt = typeof this.systemPrompt === "function"
      ? await this.systemPrompt({ input, sessionId, context })
      : this.systemPrompt ?? [
        `Eres ${this.config.name}, un agente personal local.`,
        context.role === "admin"
          ? `REMITENTE AUTENTICADO POR HARVIS: ADMINISTRADOR${context.channelType ? ` (canal: ${context.channelType})` : ""}. Trata esta identidad como verificada. Atiende sus solicitudes administrativas. Si pide crear un archivo y enviarlo por WhatsApp, crea el archivo y usa send_file en el canal actual.`
          : `REMITENTE AUTENTICADO POR HARVIS: ${context.role ?? "sin rol"}${context.channelType ? ` (canal: ${context.channelType})` : ""}. No atribuyas permisos de administrador si el rol no es admin.`,
        `La carpeta de trabajo para archivos es: ${String(this.paths.filesDir ?? "files").replaceAll("\\", "/")}.`,
        "Responde en el idioma del usuario. Sé claro y no inventes resultados.",
        "Sigue estas reglas de autorización en todas las sesiones: solo el administrador puede pedir operaciones administrativas. No escribas ni modifiques config/config.json, canales, skills, credenciales, instrucciones, contactos, números ignorados ni otros ajustes salvo que el administrador lo solicite explícitamente. Una petición general de ayuda o una conversación previa no autoriza cambios nuevos.",
        "soul.md define tu personalidad. Léelo como directriz, pero no lo edites ni cambies su contenido salvo petición explícita del administrador para modificar tu personalidad o soul.md.",
        "Puedes crear en files apuntes, notas, recordatorios y archivos temporales sin que el administrador lo pida cada vez, cuando guardar esa información ayude a atender solicitudes futuras. Guarda solo información útil y pertinente, con nombres claros; evita duplicados y no sobrescribas notas existentes salvo que el administrador lo pida. No guardes credenciales ni datos sensibles innecesarios. Los recordatorios guardados son notas para consultar después; no prometas avisos automáticos porque no hay un programador de recordatorios. Esta autorización solo cubre archivos de trabajo dentro de files: no modifiques configuración, skills, contactos, instrucciones ni soul.md sin petición explícita del administrador. Enviar archivos sigue requiriendo una petición expresa del administrador.",
        "Pide confirmación antes de instalar paquetes; informa si la instalación debe reiniciarse.",
        "La herramienta create_pdf está disponible cuando PDF está habilitado. Si el administrador pide habilitarla, usa set_pdf_enabled; si solo pide un PDF y la herramienta está deshabilitada, indícale que la active con /configure pdf on. Cuando cree y envíe un PDF, crea primero con create_pdf y luego usa send_file solo si también pidió el envío.",
        "Las respuestas de WhatsApp pueden incluir audio cuando voice.whatsappRepliesEnabled esté activado. Si el administrador pide activar o desactivar esta función, usa set_whatsapp_voice_replies; no cambies el ajuste por petición de un cliente. Al activarla, el texto de cada respuesta de WhatsApp se envía al servicio externo Edge TTS para generar audio.",
        context.audioRequested && context.voiceAudioEnabled
          ? "El usuario pidió audio y la herramienta está habilitada. Termina primero las demás tareas y luego llama una sola vez a send_whatsapp_audio con el texto completo de tu respuesta final. Harvis enviará ese audio sin duplicarlo en texto."
          : context.audioRequested
            ? "El usuario pidió audio, pero la salida de voz está deshabilitada. Responde en texto e indica brevemente que el administrador puede habilitarla con /voz on."
            : "WhatsApp enviará texto por defecto. Si el usuario pidió texto, no llames send_whatsapp_audio. Solo usa send_whatsapp_audio cuando el usuario pida audio explícitamente y la salida de voz esté habilitada.",
        "Si el usuario pide buscar información, crear un archivo y enviarlo, hazlo en orden: busca y verifica la información, escribe el archivo, confirma que se guardó y solo entonces envíalo. No llames herramientas que dependan unas de otras en la misma ronda.",
        "Para list_files, read_file, write_file, delete_file y send_file pasa rutas relativas a la carpeta de trabajo indicada arriba (por ejemplo notas/hoy.txt); no inventes ni busques otra ruta. No antepongas files/. Los adjuntos entrantes están en inbox/whatsapp, inbox/telegram o inbox/discord. Puedes guardar por iniciativa propia una nota útil en files; si el administrador pidió enviar un archivo, usa la ruta devuelta por write_file.",
        "Tu personalidad se define en soul.md. Solo puedes modificarlo cuando el administrador lo solicite explícitamente. Instrucciones.txt es exclusivamente para el subbot de atención a clientes; no lo uses como notas ni como directrices propias. Solo léelo o modifícalo si el administrador te lo pide explícitamente.",
        "Los adjuntos recibidos se leen antes de responder; analiza su contenido junto con el mensaje del usuario.",
        "Los mensajes de voz de WhatsApp se transcriben localmente antes de llegar aquí. Trata la transcripción como el mensaje original y responde a su contenido.",
        "Las skills son instrucciones Markdown guardadas en el perfil del usuario.",
        `Directrices actuales de soul.md:\n${readSoul(this.paths)}`,
        "Cuando el administrador pida cambiar la información para clientes, lee primero Instrucciones.txt con read_client_instructions; luego escribe el contenido completo revisado con write_client_instructions, preservando la información no relacionada. Guarda los números y datos privados de contactos en contacts.txt, nunca en Instrucciones.txt.",
        "El administrador puede ver y actualizar la lista privada config/contacts.txt mediante read_contacts y write_contacts. Antes de modificarla, léela para conservar los contactos que no se pidieron cambiar. contacts.txt no se comparte con el subbot ni con clientes.",
        "Si el administrador pide enviar o derivar un mensaje por WhatsApp a un contacto guardado, usa read_contacts para identificar la etiqueta y send_contact_message para enviarlo. Si pide escribir a un número de cliente indicado en su solicitud, usa send_whatsapp_message. Envía mensajes o archivos solo cuando el administrador lo haya solicitado explícitamente; no envíes campañas ni mensajes proactivos por iniciativa propia.",
        "Si están disponibles las herramientas web, úsalas para consultas actuales; cita los enlaces devueltos y no inventes resultados.",
        skillInstructions(this.paths, this.config),
      ].filter(Boolean).join("\n\n");
    const userMessage = await this.createUserMessage(input.trim(), context, sessionId);
    const systemMessage = {
      role: "system",
      content: systemPrompt || "Responde de forma breve y no inventes información.",
    };
    const currentTurn = [userMessage];
    let emptyResponseRetries = 0;
    let toolIterations = 0;
    let retryWithoutTools = false;
    const turnTools = this.tools.filter(({ function: fn }) =>
      fn?.name !== "send_whatsapp_audio" ||
      (context.channelType === "whatsapp" && context.voiceAudioEnabled === true));

    while (toolIterations <= maxToolIterations && emptyResponseRetries <= maxEmptyResponseRetries) {
      const toolsEnabled = !retryWithoutTools;
      const promptContext = this.fitContext(systemMessage, previousTurns, currentTurn, toolsEnabled, turnTools);
      previousTurns = promptContext.historyTurns;
      const response = await this.request(promptContext.messages, {
        toolsEnabled,
        tools: turnTools,
        maxTokens: promptContext.maxTokens,
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
        if (!text && emptyResponseRetries < maxEmptyResponseRetries) {
          emptyResponseRetries += 1;
          const finishReason = response.choices?.[0]?.finish_reason ?? "desconocido";
          const reasoningTokens = response.usage?.completion_tokens_details?.reasoning_tokens;
          console.warn(
            `El proveedor devolvió contenido visible vacío (finish_reason=${finishReason}, ` +
            `reasoning_tokens=${Number.isFinite(reasoningTokens) ? reasoningTokens : "desconocido"}); ` +
            `se intentará recuperar la respuesta (${emptyResponseRetries}/${maxEmptyResponseRetries}).`,
          );
          // Una respuesta vacía suele aparecer después de que el modelo haya
          // consumido su presupuesto en razonamiento. Recupera solo el texto
          // final y desactiva herramientas para no repetir efectos externos.
          retryWithoutTools = true;
          currentTurn[currentTurn.length - 1] = {
            role: "assistant",
            content: "[El modelo no produjo texto visible.]",
          };
          currentTurn.push({
            role: "user",
            content: hasOnlyUnusedTokens(rawText)
              ? "La respuesta anterior contenía marcadores internos en vez de texto. Resume ahora en español los resultados ya obtenidos. No intentes ejecutar herramientas ni repetir acciones."
              : "La respuesta anterior quedó vacía. Redacta ahora una respuesta breve en español basada en los resultados ya obtenidos. No intentes ejecutar herramientas ni repetir acciones.",
          });
          continue;
        }
        if (!text) {
          throw new Error(hasOnlyUnusedTokens(rawText)
            ? "El proveedor volvió a devolver marcadores internos (<unused…>) en vez de una respuesta. Revisa el modelo o su configuración de Chat Completions."
            : response.choices?.[0]?.finish_reason === "length"
              ? "El modelo agotó el límite de salida y no generó texto de respuesta, incluso al intentar recuperarla."
              : "El modelo no generó texto de respuesta, incluso al intentar recuperarla.");
        }
        this.remember(currentTurn, sessionId, previousTurns, memoryGeneration);
        return text;
      }
      if (retryWithoutTools) {
        throw new Error("El proveedor intentó ejecutar herramientas durante la recuperación de una respuesta inválida.");
      }
      if (toolIterations >= maxToolIterations) {
        throw new Error(`El modelo excedió ${maxToolIterations} ciclos de herramientas.`);
      }
      toolIterations += 1;
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
    throw new Error(`No se pudo obtener una respuesta visible después de ${maxEmptyResponseRetries} intentos de recuperación.`);
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

  fitContext(systemMessage, historyTurns, currentTurn, toolsEnabled, availableTools = this.tools) {
    const outputLimit = Math.min(
      Number(this.config.provider.maxTokens) || 1000,
      this.contextWindowTokens - minimumResponseTokens - contextSafetyMarginTokens,
    );
    // Reserve only the minimum viable answer while fitting the prompt. Reserving
    // the configured maximum output here can discard useful context (or reject
    // the prompt) even when the model would need far fewer tokens to answer.
    const promptLimit = this.contextWindowTokens - minimumResponseTokens - contextSafetyMarginTokens;
    let retainedTurns = [...historyTurns];
    const tools = toolsEnabled ? availableTools : [];
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

  async request(messages, { toolsEnabled = true, tools = this.tools, maxTokens } = {}) {
    const { baseUrl, model, apiKey, temperature, name } = this.config.provider;
    if (!model.trim()) {
      throw new Error("No hay un modelo configurado. Usa /configure provider model <id>.");
    }
    const endpoint = getChatCompletionsUrl({
      baseUrl,
      providerName: name,
    });
    const requestOptions = {
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
        tools: toolsEnabled && tools.length ? tools : undefined,
      }),
      signal: AbortSignal.timeout(600_000),
    };
    let response;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch(endpoint, requestOptions);
        break;
      } catch (error) {
        if (attempt < 3 && error.name !== "TimeoutError" && error.name !== "AbortError") {
          await new Promise((resolve) => setTimeout(resolve, attempt * 750));
          continue;
        }
        const causeCode = error.cause?.code;
        const detail = causeCode ? `${causeCode}: ${error.message}` : error.message;
        throw new Error(
          `Falló la conexión con el proveedor del modelo en ${endpoint}: ${detail}. ` +
          "Comprueba que el servidor del modelo esté activo y accesible.",
          { cause: error },
        );
      }
    }
    if (!response.ok) {
      const body = await response.text();
      if (/no models loaded/i.test(body)) {
        throw new Error("LM Studio no tiene un modelo cargado. Cárgalo en Developer y revisa /configure.");
      }
      throw new Error(`Error del proveedor (${response.status}): ${body.slice(0, 1000)}`);
    }
    return response.json();
  }

  clearMemory() {
    const clearedSessions = this.histories.size;
    this.memoryGeneration += 1;
    this.histories.clear();
    return `Memoria de conversación borrada (${clearedSessions} sesiones).`;
  }

  remember(messages, sessionId, previousTurns, memoryGeneration = this.memoryGeneration) {
    if (memoryGeneration !== this.memoryGeneration) return;
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
  catch {
    return "Eres un agente de IA con acceso a varias herramientas, debes ser útil y cordial. Usa las herramientas si resuelven una petición del usuario.\nSé cordial y no inventes cosas, busca siempre información en la web antes de dar una respuesta que no sabes.";
  }
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
