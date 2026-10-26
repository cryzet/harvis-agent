import { createInterface } from "node:readline";
import { getChatCompletionsUrl } from "./provider-models.js";

export class InteractiveConsole {
  constructor({ config, save, handlers }) {
    this.config = config;
    this.save = save;
    this.handlers = handlers;
    this.readline = null;
    this.pendingPrompt = null;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  async start({ showPrompt = true, showBanner = true } = {}) {
    this.readline = createInterface({ input: process.stdin, output: process.stdout });
    this.readline.on("line", (line) => this.handleInputLine(line));
    if (showBanner) this.printBanner();
    if (showPrompt) this.prompt();
    return this;
  }

  handleInputLine(line) {
    if (this.pendingPrompt) {
      const resolve = this.pendingPrompt;
      this.pendingPrompt = null;
      resolve(line);
      return;
    }
    this.queue = this.queue.then(() => this.handleLine(line)).catch((error) => {
      console.error(`Error procesando entrada: ${error.message}`);
    });
  }

  clearScreen(output = process.stdout) {
    if (output.isTTY) output.write("\x1B[2J\x1B[H");
  }

  async close() {
    this.closed = true;
    if (this.pendingPrompt) {
      this.pendingPrompt("");
      this.pendingPrompt = null;
    }
    this.readline?.close();
  }

  confirmInstall(packageName, purpose) {
    const packages = {
      whatsapp: "baileys@7.0.0-rc14 y qrcode-terminal@0.12.0",
      telegram: "grammy@1.46.0",
      discord: "discord.js@14.27.0",
    }[packageName.toLowerCase()] ?? packageName;
    return this.ask(`Instalar ${purpose} npm "${packages}"? Puede ejecutar scripts del paquete. Escribe si/no: `)
      .then((answer) => ["si", "sí", "s"].includes(answer.trim().toLowerCase()));
  }

  async ask(prompt, { secret = false } = {}) {
    if (!this.readline || this.closed || this.pendingPrompt) {
      throw new Error("No se puede solicitar confirmación en este momento.");
    }
    const readline = this.readline;
    const originalWrite = readline._writeToOutput;
    const hideInput = secret && readline.terminal;
    const readlinePrompt = `\n⚠ ${prompt}`;
    readline.setPrompt(readlinePrompt);
    readline.prompt();
    if (hideInput) {
      readline._writeToOutput = (output) => originalWrite(maskInput(output));
    }
    return new Promise((resolve) => {
      this.pendingPrompt = (answer) => {
        this.pendingPrompt = null;
        if (hideInput) {
          readline._writeToOutput = originalWrite;
          if (readline.history?.[0] === answer) readline.history.shift();
        }
        resolve(answer);
      };
    });
  }

  async handleLine(line) {
    const input = line.trim();
    if (!input) return this.prompt();
    try {
      if (!input.startsWith("/")) {
        const answer = await this.withActivityIndicator(
          `${this.config.name} está pensando`,
          () => this.handlers.reply(input),
        );
        this.printAssistantReply(answer);
      } else {
        const response = await this.command(input);
        if (response) console.log(`\n${response}\n`);
      }
    } catch (error) {
      console.error(`\n✖ ${error.message}`);
    }
    this.prompt();
  }

  async withActivityIndicator(label, action) {
    if (!process.stdout.isTTY) {
      process.stdout.write(`◇ ${label}...\n`);
      return action();
    }
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const color = process.env.NO_COLOR === undefined
      ? (value) => `\x1b[36m${value}\x1b[0m`
      : (value) => value;
    let frame = 0;
    const render = () => {
      process.stdout.write(`\r${color(frames[frame])} ${label}...`);
      frame = (frame + 1) % frames.length;
    };
    render();
    const timer = setInterval(render, 90);
    try {
      return await action();
    } finally {
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K");
    }
  }

  printAssistantReply(answer) {
    const color = process.stdout.isTTY && process.env.NO_COLOR === undefined
      ? (value) => `\x1b[1;36m${value}\x1b[0m`
      : (value) => value;
    const lines = String(answer).split(/\r?\n/);
    const body = lines.map((line) => `│  ${line}`).join("\n");
    process.stdout.write([
      "",
      ` ${color(this.config.name)}`,
      "",
      body,
      "",
      "",
      "",
    ].join("\n"));
  }

  async command(input) {
    const [rawCommand, ...args] = input.split(/\s+/);
    const command = rawCommand.toLowerCase();
    switch (command) {
      case "/help": return this.help();
      case "/status": return this.handlers.status();
      case "/models": return this.handlers.models();
      case "/channels": return this.handlers.channels();
      case "/skills": return this.handlers.skills();
      case "/configure": return this.configure(args);
      case "/restart":
        return this.handlers.restart();
      case "/start":
        return this.handlers.startService();
      case "/stop":
        return this.handlers.stopService();
      case "/quit":
      case "/exit":
        await this.close();
        return "Consola cerrada. El servicio continúa en segundo plano.";
      default: return `Comando desconocido: ${rawCommand}. Usa /help.`;
    }
  }

  async configure(args) {
    if (!args.length) return this.configureMenu();
    const [targetRaw, ...rest] = args;
    const target = targetRaw.toLowerCase();
    if (target === "name") {
      const name = rest.join(" ").trim();
      if (!name) throw new Error("Uso: /configure name <nombre>.");
      this.config.name = name;
      this.save();
      return `Nombre guardado: ${name}.`;
    }
    if (target === "provider") {
      if (!rest.length) return this.configureProvider();
      const [keyRaw, ...valueParts] = rest;
      const key = keyRaw?.toLowerCase();
      const value = valueParts.join(" ").trim();
      const keys = { url: "baseUrl", model: "model", "api-key": "apiKey", key: "apiKey" };
      if (!keys[key] || !value) {
        throw new Error("Uso: /configure provider url|model|api-key <valor>.");
      }
      if (key === "url") {
        let url;
        try { url = new URL(value); } catch { throw new Error("La URL no es válida."); }
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("Usa una URL HTTP o HTTPS.");
      }
      this.config.provider[keys[key]] = value;
      this.save();
      return key === "api-key" || key === "key"
        ? "API key guardada."
        : "Parámetro del proveedor actualizado.";
    }
    if (target === "mcp") return this.configureMcp();
    if (target === "instructions") {
      const [action, ...content] = rest;
      if (action === "show") return this.handlers.readInstructions();
      if (action === "set" && content.length) {
        return this.handlers.writeInstructions(content.join(" "));
      }
      throw new Error("Uso: /configure instructions show | set <texto>.");
    }
    if (target === "ignore") {
      const [action, number] = rest;
      if (action === "list") {
        const numbers = await this.handlers.ignoredNumbers();
        return numbers.length ? numbers.join("\n") : "Ignore.txt no contiene números.";
      }
      if (["add", "remove"].includes(action) && number) {
        return this.handlers.changeIgnoredNumber(number, action);
      }
      throw new Error("Uso: /configure ignore list | add <+número> | remove <+número>.");
    }
    if (target === "web") return this.configureWeb(rest);
    if (target === "channels" || target === "channel") {
      if (target === "channels" || !rest.length) return this.configureChannels();
      return this.configureChannel(rest);
    }
    if (target === "skills" || target === "skill") {
      if (target === "skills" || !rest.length) return this.configureSkills();
      return this.configureSkill(rest);
    }
    throw new Error("Uso: /configure [provider|channels|skills|web|name|instructions|ignore] ...");
  }

  async configureMenu() {
    console.log([
      "",
      `┌  ${this.config.name} · Configuración`,
      "│",
      "◆ Selecciona una sección",
      "│  1) Modelo / autenticación",
      "│  2) Canales de comunicación",
      "│  3) Skills",
      "│  4) Perfil del agente",
      "│  5) Búsqueda web y scraping",
      "│  6) MCP local",
      "│  7) Instrucciones para clientes",
      "│  8) Números ignorados",
      "└  0) Salir",
    ].join("\n"));
    const selection = (await this.ask("Selección: ")).trim();
    switch (selection) {
      case "1": return this.configureProvider();
      case "2": return this.configureChannels();
      case "3": return this.configureSkills();
      case "4": return this.configureName();
      case "5": return this.configureWeb();
      case "6": return this.configureMcp();
      case "7": return this.configureInstructions();
      case "8": return this.configureIgnore();
      case "0": return "Configuración sin cambios.";
      default: throw new Error("Opción inválida. Ejecuta /configure e intenta de nuevo.");
    }
  }

  async configureInstructions() {
    const instructions = await this.handlers.readInstructions();
    console.log(`\nInstrucciones actuales:\n${instructions || "(vacías; los clientes recibirán una respuesta genérica)"}\n`);
    const action = (await this.ask("Escribe 'set' para reemplazarlas o Enter para volver: "))
      .trim().toLowerCase();
    if (action !== "set") return "Sin cambios.";
    const content = await this.ask("Nuevas instrucciones: ");
    if (!content.trim()) throw new Error("Las instrucciones no pueden quedar vacías.");
    return this.handlers.writeInstructions(content);
  }

  async configureIgnore() {
    const numbers = await this.handlers.ignoredNumbers();
    console.log(`\nNúmeros ignorados:\n${numbers.length ? numbers.join("\n") : "(ninguno)"}\n`);
    return "Usa /configure ignore add <+número> o /configure ignore remove <+número>.";
  }

  async onboard() {
    console.log([
      "",
      `┌  ${this.config.name} · Configuración inicial`,
      "│",
      "◆ Bienvenido. Configuraremos proveedor, canales, skills y herramientas web.",
      `│  ${this.config.name} se ejecuta localmente; MCP usa stdio local y no abre un gateway.`,
      "│",
      "◆ Seguridad: los canales conectan tu cuenta de mensajería con este agente.",
      "│  Usa allowlists y concede solo los permisos necesarios.",
      "└  La configuración y los tokens se guardan en tu perfil local.",
    ].join("\n"));

    const mode = (await this.ask(
      "\nSetup mode:\n  1) QuickStart (recomendado)\n  2) Manual setup\nSelección [1]: ",
    )).trim() || "1";
    if (!["1", "2"].includes(mode)) throw new Error("Elige QuickStart o Manual setup.");
    if (mode === "2") {
      console.log([
        "",
        "Nota de seguridad",
        "Los canales pueden recibir mensajes y transmitirlos al proveedor de IA.",
        "Las skills instaladas pueden ejecutar scripts npm durante la instalación.",
        "Revisa los permisos de bots y limita el acceso a contactos autorizados.",
      ].join("\n"));
      const accepted = (await this.ask("¿Entiendes y aceptas estos riesgos? [s/N]: "))
        .trim().toLowerCase();
      if (!["s", "si", "sí", "y", "yes"].includes(accepted)) {
        return "Configuración inicial cancelada. No se guardaron cambios.";
      }
    }

    const providerChoice = (await this.ask([
      "",
      "Modelo / autenticación",
      "  1) LM Studio (local)",
      "  2) OpenAI",
      "  3) Endpoint compatible con OpenAI",
      "  4) Configurarlo después",
      "Proveedor [1]: ",
    ].join("\n"))).trim() || "1";
    const providerNames = { "1": "lmstudio", "2": "openai", "3": "custom" };
    if (providerNames[providerChoice]) {
      await this.configureProvider(providerNames[providerChoice]);
    } else if (providerChoice !== "4") {
      throw new Error("Selecciona una opción de proveedor del 1 al 4.");
    }

    const verify = (await this.ask(
      "¿Probar el proveedor ahora con una solicitud real? Puede generar coste en servicios cloud. [s/N]: ",
    )).trim().toLowerCase();
    if (["s", "si", "sí", "y", "yes"].includes(verify)) {
      try {
        await this.verifyProvider();
      } catch (error) {
        console.error(`No se pudo verificar el proveedor: ${error.message}`);
        const recovery = (await this.ask(
          [
            "Recuperación del proveedor",
            "│  1) Reconfigurar proveedor",
            "│  2) Continuar sin verificar",
            "│  3) Cancelar setup",
            "└  Selección: ",
          ].join("\n"),
        )).trim();
        if (recovery === "1") {
          await this.configureProvider();
        } else if (recovery === "3") {
          return "Configuración inicial cancelada. Puedes retomarla con /configure.";
        } else if (recovery !== "2") {
          throw new Error("Selecciona 1, 2 o 3 para continuar.");
        }
      }
    }

    await this.onboardChannels();

    const skillsChoice = (await this.ask([
      "",
      "Skills",
      "  1) Crear una skill",
      "  2) Instalar una skill desde npm",
      "  3) Omitir por ahora",
      "Skills [3]: ",
    ].join("\n"))).trim() || "3";
    if (skillsChoice === "1") {
      const name = (await this.ask("Nombre de la skill: ")).trim();
      const instructions = (await this.ask("Instrucciones: ")).trim();
      const result = await this.handlers.createSkill({ name, instructions });
      console.log(result);
    } else if (skillsChoice === "2") {
      const packageName = (await this.ask("Paquete npm de la skill: ")).trim();
      if (packageName) console.log(await this.handlers.installSkill(packageName));
    } else if (skillsChoice !== "3") {
      throw new Error("Selecciona una opción de skills del 1 al 3.");
    }

    await this.configureWeb([], { onboarding: true });

    const useMcp = (await this.ask("¿Habilitar herramientas MCP locales por stdio? [S/n]: "))
      .trim().toLowerCase();
    this.config.mcp.enabled = !["n", "no"].includes(useMcp);
    this.config.setupComplete = true;
    this.save();
    console.log([
      "",
      "┌  Configuración completada",
      `│  Agente: ${this.config.name}`,
      `│  Proveedor: ${this.config.provider.name ?? "pendiente"}`,
      `│  Modelo: ${this.config.provider.model ? "configurado" : "pendiente"}`,
      `│  Web search: ${this.config.web.searchEnabled ? this.config.web.searchProvider : "deshabilitado"}`,
      `│  Web scraping: ${this.config.web.scrapeEnabled ? "habilitado" : "deshabilitado"}`,
      `│  MCP local: ${this.config.mcp.enabled ? "stdio habilitado" : "deshabilitado"}`,
      "│",
      `◆ ${this.config.name} iniciará sus canales en un servicio local persistente.`,
      "└  Usa /help para ver comandos o /configure para cambiar opciones.",
    ].join("\n"));
    return "Setup completado.";
  }

  async onboardChannels() {
    const channelNames = { "1": "whatsapp", "2": "telegram", "3": "discord" };
    for (;;) {
      const channelChoice = (await this.ask([
      "",
      "Canales",
      "  1) Configurar WhatsApp",
      "  2) Configurar Telegram",
      "  3) Configurar Discord",
      "  4) Omitir por ahora",
      "Canal [4]: ",
      ].join("\n"))).trim() || "4";
      if (channelNames[channelChoice]) {
        await this.onboardChannel(channelNames[channelChoice]);
        const addAnother = (await this.ask("¿Configurar otro canal? [s/N]: "))
          .trim().toLowerCase();
        if (["s", "si", "sí", "y", "yes"].includes(addAnother)) continue;
        return;
      }
      if (channelChoice === "4") return;
      throw new Error("Selecciona un canal del 1 al 4.");
    }
  }

  async configureWeb(args = [], { onboarding = false } = {}) {
    this.config.web ??= {
      searchEnabled: true,
      searchProvider: "duckduckgo",
      searchApiKey: "",
      scrapeEnabled: true,
      maxResults: 5,
    };
    if (args.length && !onboarding) {
      const [setting, ...values] = args;
      const value = values.join(" ").trim();
      if (setting === "provider" && ["duckduckgo", "brave", "off"].includes(value)) {
        this.config.web.searchEnabled = value !== "off";
        if (value !== "off") this.config.web.searchProvider = value;
      } else if (setting === "api-key" && value) {
        this.config.web.searchApiKey = value;
      } else if (setting === "scrape" && ["on", "off"].includes(value)) {
        this.config.web.scrapeEnabled = value === "on";
      } else {
        throw new Error("Uso: /configure web provider <duckduckgo|brave|off> | api-key <clave> | scrape on|off.");
      }
      this.save();
      return "Configuración web guardada. Ejecuta /restart para aplicar cambios de herramientas.";
    }

    if (!onboarding) {
      console.log([
        "",
        "Web · búsqueda y extracción de páginas",
        `Búsqueda: ${this.config.web.searchEnabled ? this.config.web.searchProvider : "deshabilitada"}`,
        `Scraping: ${this.config.web.scrapeEnabled ? "habilitado" : "deshabilitado"}`,
        "La extracción solo permite HTTP(S) público; bloquea redes locales y privadas.",
      ].join("\n"));
    } else {
      console.log([
        "",
        "Web search y web scraping",
        "DuckDuckGo funciona sin API key; Brave Search requiere una API key.",
        "La extracción descarga solo HTML público, con límites de tamaño y tiempo.",
      ].join("\n"));
    }
    const choice = (await this.ask(
      [
        "Búsqueda:",
        "  1) DuckDuckGo gratis",
        "  2) Brave Search",
        "  3) Deshabilitar",
        "Selección [1]: ",
      ].join("\n"),
    )).trim() || "1";
    if (!["1", "2", "3"].includes(choice)) {
      throw new Error("Selecciona una opción web del 1 al 3.");
    }
    this.config.web.searchEnabled = choice !== "3";
    if (choice === "1") {
      this.config.web.searchProvider = "duckduckgo";
      this.config.web.searchApiKey = "";
    } else if (choice === "2") {
      this.config.web.searchProvider = "brave";
      const apiKey = await this.ask(
        this.config.web.searchApiKey
          ? "API key de Brave (Enter conserva la actual, 'clear' la borra): "
          : "API key de Brave (obligatoria): ",
      );
      if (apiKey.trim().toLowerCase() === "clear") this.config.web.searchApiKey = "";
      else if (apiKey.trim()) this.config.web.searchApiKey = apiKey.trim();
      if (!this.config.web.searchApiKey) {
        this.config.web.searchEnabled = false;
        console.log("La búsqueda Brave queda deshabilitada hasta configurar una API key.");
      }
    }
    const scrape = (await this.ask("¿Habilitar web scraping seguro de páginas públicas? [S/n]: "))
      .trim().toLowerCase();
    this.config.web.scrapeEnabled = !["n", "no"].includes(scrape);
    if (!onboarding) {
      this.save();
      return "Configuración web guardada. Ejecuta /restart para aplicar cambios de herramientas.";
    }
    return "Configuración web guardada.";
  }

  async onboardChannel(type) {
    const installed = this.config.channels.some((channel) => channel.type === type);
    if (!installed) {
      const install = (await this.ask(`¿Instalar ${type} ahora? [S/n]: `))
        .trim().toLowerCase();
      if (["n", "no"].includes(install)) return;
      if (!(await this.confirmInstall(type, "canal"))) {
        console.log(`Instalación de ${type} omitida.`);
        return;
      }
      console.log(await this.handlers.installChannel(type));
    }
    if (type === "whatsapp" && installed) {
      console.log(await this.handlers.setupWhatsApp());
    }
    if (type === "telegram" || type === "discord") {
      const channel = this.config.channels.find((entry) => entry.type === type);
      const token = (await this.ask(`Token del bot de ${type}: `, { secret: true })).trim();
      if (!token) {
        channel.enabled = false;
        this.save();
        console.log(`${type} queda deshabilitado hasta configurar su token.`);
        return;
      }
      channel.token = token;
      channel.enabled = true;
      this.save();
    }
  }

  async verifyProvider() {
    const { baseUrl, model, apiKey, name } = this.config.provider;
    if (!model.trim()) throw new Error("Configura un modelo antes de probar el proveedor.");
    let response;
    const endpoint = getChatCompletionsUrl({ baseUrl, providerName: name });
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: ["Bearer", apiKey].join(" ") } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: "Responde exactamente con la palabra OK, sin explicación.",
          }],
          max_tokens: 1000,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(600_000),
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new Error("La prueba agotó 600 segundos (10 minutos). El modelo puede estar cargándose; vuelve a probar cuando esté listo.");
      }
      throw new Error(`No se pudo conectar al endpoint ${endpoint}: ${error.message}`);
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `El endpoint ${endpoint} respondió HTTP ${response.status}. ${sanitizeProviderDetail(detail, apiKey)}`,
      );
    }
    const body = await response.text();
    let result;
    try {
      result = JSON.parse(body);
    } catch {
      throw new Error(
        `El endpoint ${endpoint} respondió HTTP ${response.status}, pero no devolvió JSON válido: ${sanitizeProviderDetail(body, apiKey)}`,
      );
    }
    const choice = result.choices?.[0];
    const message = choice?.message;
    const hasContent = typeof message?.content === "string" && message.content.trim().length > 0;
    const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
    if (message?.role !== "assistant" || (!hasContent && !hasToolCalls)) {
      const truncated = choice?.finish_reason === "length"
        ? " La respuesta se truncó al alcanzar el límite de tokens; aumenta el límite de salida del modelo o vuelve a probar."
        : "";
      throw new Error(
        `El endpoint ${endpoint} respondió, pero no devolvió una respuesta Chat Completions válida. ` +
        `Comprueba que la URL termine en /v1 para LM Studio, que la ruta sea /chat/completions ` +
        `y que el modelo "${model}" esté cargado.${truncated} Respuesta: ${sanitizeProviderDetail(body, apiKey)}`,
      );
    }
    console.log("Conexión del proveedor verificada.");
  }

  async configureProvider(providerSelection) {
    const provider = this.config.provider;
    const kind = providerSelection ?? (await this.ask(
      "Proveedor [lmstudio/openai/custom] (Enter conserva actual): ",
    )).trim().toLowerCase();
    if (kind && !["lmstudio", "openai", "custom"].includes(kind)) {
      throw new Error("Selecciona lmstudio, openai o custom.");
    }
    if (kind) provider.name = kind;
    const suggestedUrl = kind === "lmstudio"
      ? "http://127.0.0.1:1234/v1"
      : kind === "openai"
        ? "https://api.openai.com/v1"
        : provider.baseUrl;
    const baseUrl = (await this.ask(
      `URL del proveedor (${suggestedUrl ? "Enter usa la URL predeterminada" : "Enter conserva la actual"}): `,
    )).trim();
    if (baseUrl) {
      let parsed;
      try { parsed = new URL(baseUrl); } catch { throw new Error("La URL no es válida."); }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("La URL debe usar HTTP o HTTPS.");
      }
      provider.baseUrl = baseUrl.replace(/\/+$/, "");
    } else if (kind === "lmstudio" || kind === "openai") {
      provider.baseUrl = suggestedUrl;
    }
    const keyPrompt = provider.apiKey
      ? "API key (Enter conserva la actual, escribe 'clear' para borrarla): "
      : "API key (Enter si no requiere): ";
    const apiKey = await this.ask(keyPrompt);
    if (apiKey.trim().toLowerCase() === "clear") provider.apiKey = "";
    else if (apiKey.trim()) provider.apiKey = apiKey.trim();
    await this.selectProviderModel();
    this.save();
    return "Proveedor y credenciales guardados.";
  }

  async selectProviderModel() {
    const provider = this.config.provider;
    let models = [];
    if (typeof this.handlers.providerModels === "function") {
      try {
        models = await this.handlers.providerModels();
      } catch (error) {
        console.log(`No se pudieron listar los modelos del proveedor: ${error.message}`);
      }
    }

    if (!Array.isArray(models) || models.length === 0) {
      console.log("No hay modelos disponibles para listar. Puedes escribir el ID manualmente.");
      const model = (await this.ask(
        `ID del modelo (${provider.model ? "Enter conserva el actual" : "obligatorio"}): `,
      )).trim();
      if (model) provider.model = model;
      return;
    }

    const maxListedModels = 50;
    const visibleModels = models.slice(0, maxListedModels);
    const manualOption = visibleModels.length + 1;
    console.log([
      "",
      "Modelos disponibles",
      ...visibleModels.map((model, index) =>
        `│  ${index + 1}) ${model}${model === provider.model ? " (actual)" : ""}`),
      `└  ${manualOption}) Ingresar nombre manual`,
      ...(models.length > maxListedModels
        ? [`Solo se muestran los primeros ${maxListedModels} modelos.`]
        : []),
    ].join("\n"));
    const selection = (await this.ask(
      `Selecciona un modelo${provider.model ? " (Enter conserva el actual)" : ""}: `,
    )).trim();
    if (!selection) return;
    if (selection === String(manualOption)) {
      const model = (await this.ask("ID del modelo: ")).trim();
      if (!model) throw new Error("El ID del modelo no puede estar vacío.");
      provider.model = model;
      return;
    }
    const index = Number(selection) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= visibleModels.length) {
      throw new Error("Selecciona un número de modelo de la lista o la opción manual.");
    }
    provider.model = visibleModels[index];
  }

  async configureName() {
    const name = (await this.ask(`Nombre del agente [${this.config.name}]: `)).trim();
    if (!name) return "El nombre no cambió.";
    this.config.name = name;
    this.save();
    return `Nombre guardado: ${name}.`;
  }

  async configureMcp() {
    console.log([
      "",
      "MCP local · transporte stdio",
      `${this.config.name} expone herramientas al cliente MCP mediante un proceso local.`,
      "No abre puertos ni usa gateway.",
    ].join("\n"));
    const enabled = (await this.ask("¿Habilitar MCP local? [S/n]: "))
      .trim().toLowerCase();
    this.config.mcp.enabled = !["n", "no"].includes(enabled);
    this.save();
    return `MCP local ${this.config.mcp.enabled ? "habilitado" : "deshabilitado"}.`;
  }

  async configureChannels() {
    console.log(`\nCanales configurados:\n${this.handlers.channels()}`);
    const action = (await this.ask(
      "\nAcción: install <whatsapp|telegram|discord|paquete-npm> | configure <canal> | enable <canal> | disable <canal> | Enter para volver: ",
    )).trim();
    if (!action) return "Sin cambios en canales.";
    const [verb, ...value] = action.split(/\s+/);
    const name = value.join(" ");
    if (verb.toLowerCase() === "install") {
      return this.configureChannel(["install", name]);
    }
    if (verb.toLowerCase() === "configure") {
      return this.configureChannel([name, "configure"]);
    }
    if (verb.toLowerCase() === "enable" || verb.toLowerCase() === "disable") {
      return this.handlers.setChannel(name.toLowerCase(), verb.toLowerCase() === "enable");
    }
    throw new Error("Usa install <canal>, enable <canal> o disable <canal>.");
  }

  async configureSkills() {
    console.log(`\nSkills instaladas:\n${this.handlers.skills()}`);
    const action = (await this.ask(
      "\nAcción: create <nombre> | install <paquete-npm> | enable <skill> | disable <skill> | Enter para volver: ",
    )).trim();
    if (!action) return "Sin cambios en skills.";
    const [verb, name, ...description] = action.split(/\s+/);
    switch (verb.toLowerCase()) {
      case "create": {
        if (!name) throw new Error("Indica el nombre de la skill.");
        const instructions = description.join(" ") ||
          await this.ask("Instrucciones de la skill: ");
        if (!instructions.trim()) throw new Error("Las instrucciones no pueden estar vacías.");
        return this.handlers.createSkill({ name, instructions: instructions.trim() });
      }
      case "install": {
        const packageName = [name, ...description].filter(Boolean).join(" ");
        if (!packageName) throw new Error("Indica el paquete npm de la skill.");
        return this.handlers.installSkill(packageName);
      }
      case "enable":
      case "disable":
        if (!name) throw new Error("Indica el nombre de la skill.");
        return this.handlers.setSkill(name.toLowerCase(), verb.toLowerCase() === "enable");
      default:
        throw new Error("Usa create <nombre>, install <paquete>, enable <skill> o disable <skill>.");
    }
  }

  async configureChannel(args) {
    const [action, nameOrState, ...rest] = args;
    if (action?.toLowerCase() === "install") {
      const name = nameOrState?.toLowerCase();
      if (!name) throw new Error("Uso: /configure channel install <whatsapp|paquete-npm>.");
      const packageSpec = ["whatsapp", "wa"].includes(name)
        ? "whatsapp"
        : name;
      if (!(await this.confirmInstall(packageSpec, "canal"))) {
        return "Instalación cancelada.";
      }
      return this.handlers.installChannel(packageSpec);
    }
    if (
      action?.toLowerCase() === "whatsapp" &&
      nameOrState?.toLowerCase() === "number"
    ) {
      return this.handlers.configureWhatsAppNumber(rest.join(" "));
    }
    if (
      action?.toLowerCase() === "whatsapp" &&
      nameOrState?.toLowerCase() === "link"
    ) {
      return this.handlers.linkWhatsApp();
    }
    if (
      ["telegram", "discord"].includes(action?.toLowerCase()) &&
      ["token", "configure"].includes(nameOrState?.toLowerCase())
    ) {
      const channel = this.config.channels.find(({ type }) => type === action.toLowerCase());
      if (!channel) {
        throw new Error(`Instala primero el canal ${action}: /configure channel install ${action}.`);
      }
      const token = rest.join(" ").trim() ||
        (await this.ask(`Token del bot de ${action} (se guardará en el perfil local): `, {
          secret: true,
        })).trim();
      if (!token) throw new Error("El token no puede estar vacío.");
      channel.token = token;
      channel.enabled = true;
      this.save();
      return `Token de ${action} guardado. Reinicia el agente para conectar el canal.`;
    }
    if (
      ["telegram", "discord"].includes(action?.toLowerCase()) &&
      ["allow", "authorize"].includes(nameOrState?.toLowerCase())
    ) {
      const senderId = rest.join(" ").trim() || (await this.ask(`ID de usuario autorizado para ${action}: `)).trim();
      return this.handlers.authorizeChannel(action.toLowerCase(), senderId);
    }
    const name = action;
    const state = [nameOrState, ...rest].join(" ").trim().toLowerCase();
    if (!name || !["on", "off"].includes(state)) {
      throw new Error("Uso: /configure channel <tipo> on|off o /configure channel install <paquete>.");
    }
    return this.handlers.setChannel(name.toLowerCase(), state === "on");
  }

  async configureSkill(args) {
    const [action, ...rest] = args;
    const name = action?.toLowerCase();
    if (name === "create") {
      const skillName = rest.shift();
      const instructions = rest.join(" ").trim();
      if (!skillName || !instructions) {
        throw new Error("Uso: /configure skill create <nombre> <instrucciones>.");
      }
      return this.handlers.createSkill({ name: skillName, instructions });
    }
    if (name === "install") {
      const packageName = rest.join(" ").trim();
      if (!packageName) throw new Error("Uso: /configure skill install <paquete-npm>.");
      return this.handlers.installSkill(packageName);
    }
    const state = rest.join(" ").trim().toLowerCase();
    if (!name || !["on", "off"].includes(state)) {
      throw new Error("Uso: /configure skill <nombre> on|off, /configure skill create <nombre> <instrucciones> o /configure skill install <paquete>.");
    }
    return this.handlers.setSkill(name, state === "on");
  }

  help() {
    return [
      "Comandos disponibles:",
      "  /help                              Ver esta ayuda",
      "  /configure                         Ver o cambiar la configuración",
      "  /configure provider                Asistente de proveedor, URL, modelo y API key",
      "  /configure channels                Instalar/habilitar/deshabilitar canales",
      "  /configure skills                  Crear/instalar/habilitar/deshabilitar skills",
      "  /configure name <nombre>           Cambiar el nombre del agente",
      "  /configure instructions show       Ver instrucciones para clientes",
      "  /configure instructions set <texto> Actualizar instrucciones para clientes",
      "  /configure ignore list             Ver números ignorados",
      "  /configure ignore add|remove <+número> Administrar Ignore.txt",
      "  /configure provider url <URL>      Configurar proveedor local o remoto",
      "  /configure provider model <id>     Elegir modelo",
      "  /configure provider api-key <key>  Guardar API key",
      "  /configure mcp                     Configurar servidor MCP local",
      "  /configure channel install whatsapp Instalar y configurar WhatsApp",
      "  /configure channel whatsapp number <+código-país-número> Configurar número permitido",
      "  /configure channel whatsapp link   Mostrar QR para vincular",
      "  /configure channel install telegram Instalar canal Telegram",
      "  /configure channel install discord  Instalar canal Discord",
      "  /configure channel telegram token  Configurar token de Telegram",
      "  /configure channel discord token   Configurar token de Discord",
      "  /configure channel <tipo> allow <id> Autorizar un usuario",
      "  /configure channel <tipo> on|off   Habilitar o deshabilitar canal",
      "  /configure skill create ...        Crear skill local",
      "  /configure skill install <npm>     Instalar skill publicada",
      "  /configure web                     Configurar búsqueda y scraping",
      "  /configure web provider <tipo>     duckduckgo, brave u off",
      "  /configure web api-key <clave>     Configurar clave de Brave",
      "  /configure web scrape on|off       Habilitar o deshabilitar scraping",
      "  /channels                          Mostrar canales",
      "  /skills                            Mostrar skills",
      "  /status                            Estado del agente",
      "  /models                            Consultar modelos disponibles",
      "  /start                             Iniciar el servicio en segundo plano",
      "  /stop                              Detener el servicio en segundo plano",
      "  /restart                           Reiniciar el servicio",
      "  /quit                              Cerrar esta consola; el servicio continúa",
      "También puedes conversar para pedir tareas o solicitar crear skills.",
    ].join("\n");
  }

  printBanner() {
    console.log([
      "",
      "┌──────────────────────────────────────────┐",
      `│  ◆ ${this.config.name} · agente local`,
      "│",
      "│  Tu asistente personal, listo para ayudar.",
      "│  Escribe /help para ver comandos y ajustes.",
      "└──────────────────────────────────────────┘",
      "",
    ].join("\n"));
  }

  prompt() {
    if (this.closed || !this.readline || this.pendingPrompt) return;
    const userLabel = process.stdout.isTTY && process.env.NO_COLOR === undefined
      ? "\x1b[1;32mUser\x1b[0m: "
      : "User: ";
    this.readline.setPrompt(userLabel);
    this.readline.prompt();
  }

}

function maskInput(output) {
  return output.split(/(\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))|\x08 \x08)/g)
    .map((part) => /^\x1B|\x08 \x08$/.test(part)
      ? part
      : part.replace(/[^\x00-\x1F\x7F-\x9F]/gu, "*"))
    .join("");
}

function sanitizeProviderDetail(detail, apiKey) {
  const safeDetail = apiKey
    ? detail.replaceAll(apiKey, "[API key oculta]")
    : detail;
  return safeDetail.replace(/\s+/g, " ").trim().slice(0, 500) || "Sin detalle del proveedor.";
}
