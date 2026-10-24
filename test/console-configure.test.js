import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveConsole } from "../src/console.js";
import { getChatCompletionsUrl } from "../src/provider-models.js";
import { normalizeInternationalPhoneNumber } from "../src/phone-number.js";

test("normalizes LM Studio chat URLs to the OpenAI-compatible v1 route", () => {
  assert.equal(
    getChatCompletionsUrl({
      baseUrl: "http://127.0.0.1:1234",
      providerName: "lmstudio",
    }),
    "http://127.0.0.1:1234/v1/chat/completions",
  );
  assert.equal(
    getChatCompletionsUrl({
      baseUrl: "http://127.0.0.1:1234/api/v1/",
      providerName: "lmstudio",
    }),
    "http://127.0.0.1:1234/v1/chat/completions",
  );
  assert.equal(
    getChatCompletionsUrl({
      baseUrl: "https://api.example/custom/v1",
      providerName: "openai",
    }),
    "https://api.example/custom/v1/chat/completions",
  );
});

test("provider verification uses a 120-second chat completion request", async (t) => {
  const terminal = new InteractiveConsole({
    config: {
      provider: {
        name: "lmstudio",
        baseUrl: "http://127.0.0.1:1234",
        model: "google/gemma-4-e2b",
        apiKey: "local-secret",
      },
    },
    save() {},
    handlers: {},
  });
  let request;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "OK" } }],
    }), { status: 200 });
  });

  await terminal.verifyProvider();

  assert.equal(request.url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer local-secret");
  assert.equal(JSON.parse(request.options.body).model, "google/gemma-4-e2b");
  assert.equal(JSON.parse(request.options.body).max_tokens, 512);
  assert.match(JSON.parse(request.options.body).messages[0].content, /exactamente con la palabra OK/);
  assert.equal(JSON.parse(request.options.body).stream, false);
  assert.ok(request.options.signal instanceof AbortSignal);
});

test("provider verification explains when reasoning consumes the output token limit", async (t) => {
  const terminal = new InteractiveConsole({
    config: {
      provider: {
        name: "lmstudio",
        baseUrl: "http://127.0.0.1:1234",
        model: "google/gemma-4-e2b",
        apiKey: "",
      },
    },
    save() {},
    handlers: {},
  });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        reasoning_content: "Thinking...",
      },
      finish_reason: "length",
    }],
  }), { status: 200 }));

  await assert.rejects(
    terminal.verifyProvider(),
    /se truncó al alcanzar el límite de tokens/,
  );
});

test("provider verification explains non-Chat-Completions response without exposing API key", async (t) => {
  const apiKey = "test-secret-key";
  const terminal = new InteractiveConsole({
    config: {
      provider: {
        name: "lmstudio",
        baseUrl: "http://127.0.0.1:1234",
        model: "google/gemma-4-e2b",
        apiKey,
      },
    },
    save() {},
    handlers: {},
  });
  t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ error: `bad key ${apiKey}` }),
    { status: 200 },
  ));

  await assert.rejects(
    terminal.verifyProvider(),
    (error) => {
      assert.match(error.message, /\/v1\/chat\/completions/);
      assert.match(error.message, /modelo .* esté cargado/);
      assert.doesNotMatch(error.message, new RegExp(apiKey));
      return true;
    },
  );
});

test("console exposes service lifecycle commands", async () => {
  const calls = [];
  const terminal = new InteractiveConsole({
    config: {},
    save() {},
    handlers: {
      startService: async () => { calls.push("start"); return "started"; },
      stopService: async () => { calls.push("stop"); return "stopped"; },
      restart: async () => "restarted",
    },
  });

  assert.equal(await terminal.command("/start"), "started");
  assert.equal(await terminal.command("/stop"), "stopped");
  assert.equal(await terminal.command("/restart"), "restarted");
  assert.deepEqual(calls, ["start", "stop"]);
});

test("clears a TTY screen without emitting terminal codes when output is redirected", () => {
  const terminal = new InteractiveConsole({ config: {}, save() {}, handlers: {} });
  const writes = [];
  terminal.clearScreen({ isTTY: true, write: (text) => writes.push(text) });
  terminal.clearScreen({ isTTY: false, write: (text) => writes.push(text) });

  assert.deepEqual(writes, ["\x1B[2J\x1B[H"]);
});

test("chat uses a friendly activity indicator and separates the assistant reply from the next prompt", async (t) => {
  const terminal = new InteractiveConsole({
    config: { name: "Luna" },
    save() {},
    handlers: { reply: async () => "Hola.\n¿En qué puedo ayudarte?" },
  });
  terminal.prompt = () => {};
  let output = "";
  t.mock.method(process.stdout, "write", (text) => {
    output += text;
    return true;
  });

  await terminal.handleLine("Hola");

  assert.match(output, /◇ Luna está pensando\.\.\./);
  assert.match(output, /┌─ Luna\n│\n│  Hola\.\n│  ¿En qué puedo ayudarte\?\n└─+/);
  assert.ok(output.endsWith("\n\n"));
});

test("TTY activity indicator clears itself when the reply fails", async (t) => {
  const terminal = new InteractiveConsole({ config: {}, save() {}, handlers: {} });
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  t.after(() => {
    if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
    else delete process.stdout.isTTY;
  });
  let output = "";
  t.mock.method(process.stdout, "write", (text) => {
    output += text;
    return true;
  });

  await assert.rejects(
    terminal.withActivityIndicator("Harvis está pensando", async () => {
      throw new Error("reply failed");
    }),
    /reply failed/,
  );

  assert.match(output, /^\r.*Harvis está pensando/);
  assert.ok(output.endsWith("\r\x1b[2K"));
});

test("configure wizard persists provider URL, model, and API key", async () => {
  const config = {
    name: "Harvis",
    provider: {
      name: "lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "",
      apiKey: "",
    },
  };
  let saves = 0;
  const terminal = new InteractiveConsole({
    config,
    save: () => { saves += 1; },
    handlers: {
      configuration: () => "current config",
      providerModels: async () => ["openai/gpt-test", "openai/gpt-mini-test"],
    },
  });
  const answers = ["1", "openai", "https://api.example/v1", "secret", "2"];
  terminal.ask = async () => answers.shift();

  const result = await terminal.configure([]);

  assert.equal(config.provider.name, "openai");
  assert.equal(config.provider.baseUrl, "https://api.example/v1");
  assert.equal(config.provider.model, "openai/gpt-mini-test");
  assert.equal(config.provider.apiKey, "secret");
  assert.equal(saves, 1);
  assert.match(result, /Proveedor y credenciales guardados/);
  assert.doesNotMatch(result, /secret/);
});

test("provider setup offers available models and puts manual entry last", async () => {
  const config = {
    provider: {
      name: "lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "",
      apiKey: "",
    },
  };
  const terminal = new InteractiveConsole({
    config,
    save() {},
    handlers: { providerModels: async () => ["model-a", "model-b"] },
  });
  const answers = ["lmstudio", "", "", "3", "custom/model-id"];
  const asked = [];
  terminal.ask = async (prompt) => {
    asked.push(prompt);
    return answers.shift();
  };

  await terminal.configureProvider();

  assert.equal(config.provider.model, "custom/model-id");
  assert.deepEqual(asked.slice(-2), [
    "Selecciona un modelo: ",
    "ID del modelo: ",
  ]);
});

test("API key prompts echo pasted input and do not interfere with readline", async () => {
  const config = {
    name: "Harvis",
    provider: {
      name: "openai",
      baseUrl: "https://api.example/v1",
      model: "example-model",
      apiKey: "",
    },
    web: {
      searchEnabled: true,
      searchProvider: "brave",
      searchApiKey: "",
      scrapeEnabled: true,
      maxResults: 5,
    },
  };
  const terminal = new InteractiveConsole({ config, save() {}, handlers: {} });
  let rendered = "";
  let currentPrompt = "";
  const readline = {
    terminal: true,
    history: [],
    _writeToOutput: (output) => { rendered += output; },
    setPrompt: (prompt) => { currentPrompt = prompt; },
    prompt() { this._writeToOutput(currentPrompt); },
  };
  terminal.readline = readline;
  terminal.closed = false;
  const pending = terminal.ask("API key: ");
  assert.equal(currentPrompt, "\n⚠ API key: ");
  assert.equal(rendered, "\n⚠ API key: ");
  readline._writeToOutput("pasted-api-key");
  assert.equal(rendered, "\n⚠ API key: pasted-api-key");
  terminal.pendingPrompt("pasted-api-key");
  await pending;
  readline._writeToOutput("still-open");
  assert.ok(rendered.endsWith("still-open"));

  const prompts = [];
  const answers = ["openai", "", "new-api-key", "", "2", "brave-api-key", "n"];
  terminal.ask = async (prompt, options) => {
    prompts.push({ prompt, options });
    return answers.shift();
  };

  await terminal.configureProvider();
  await terminal.configureWeb();

  const apiKeyPrompts = prompts.filter(({ prompt }) => /API key/.test(prompt));
  assert.equal(apiKeyPrompts.length, 2);
  assert.ok(apiKeyPrompts.every(({ options }) => options === undefined));
  assert.equal(config.provider.apiKey, "new-api-key");
  assert.equal(config.web.searchApiKey, "brave-api-key");
});

test("uses readline-managed prompts so backspace only edits the input", async () => {
  const terminal = new InteractiveConsole({ config: {}, save() {}, handlers: {} });
  const prompts = [];
  const readline = {
    setPrompt(prompt) { this.currentPrompt = prompt; },
    prompt() { prompts.push(this.currentPrompt); },
  };
  terminal.readline = readline;
  terminal.closed = false;

  const pending = terminal.ask("Ingrese URL: ");
  assert.deepEqual(prompts, ["\n⚠ Ingrese URL: "]);
  terminal.pendingPrompt("http://example.test");
  assert.equal(await pending, "http://example.test");

  terminal.prompt();
  assert.deepEqual(prompts, ["\n⚠ Ingrese URL: ", "User: "]);
});

test("QuickStart onboarding follows provider, channel, skill, web, MCP, and summary steps", async () => {
  const config = {
    name: "Harvis",
    setupComplete: false,
    provider: {
      name: "lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "",
      apiKey: "",
    },
    channels: [{ type: "console", enabled: true }],
    skills: {},
    mcp: { enabled: true, transport: "stdio" },
  };
  let saves = 0;
  const terminal = new InteractiveConsole({
    config,
    save: () => { saves += 1; },
    handlers: {
      installChannel: async () => "channel installed",
      createSkill: async () => "skill created",
      installSkill: async () => "skill installed",
    },
  });
  const answers = [
    "1", "", "1", "http://127.0.0.1:1234/v1", "", "local-model", "n", "4", "3", "", "", "",
  ];
  terminal.ask = async () => answers.shift();
  const result = await terminal.onboard();

  assert.equal(config.setupComplete, true);
  assert.equal(config.name, "Harvis");
  assert.equal(config.provider.name, "lmstudio");
  assert.equal(config.provider.model, "local-model");
  assert.equal(config.mcp.enabled, true);
  assert.equal(config.web.searchEnabled, true);
  assert.equal(config.web.searchProvider, "duckduckgo");
  assert.equal(config.web.scrapeEnabled, true);
  assert.equal(saves, 2);
  assert.match(result, /Setup completado/);
});

test("Manual setup requires explicit security acknowledgment", async () => {
  const config = {
    name: "Harvis",
    setupComplete: false,
    provider: { name: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", model: "", apiKey: "" },
    channels: [{ type: "console", enabled: true }],
    skills: {},
    mcp: { enabled: true, transport: "stdio" },
  };
  let saves = 0;
  const terminal = new InteractiveConsole({
    config,
    save: () => { saves += 1; },
    handlers: {},
  });
  const answers = ["2", "no"];
  terminal.ask = async () => answers.shift();

  assert.match(await terminal.onboard(), /cancelada/);
  assert.equal(config.setupComplete, false);
  assert.equal(saves, 0);
});

test("failed provider verification offers recovery instead of aborting startup", async () => {
  const config = {
    name: "Harvis",
    setupComplete: false,
    provider: {
      name: "lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      apiKey: "",
    },
    channels: [{ type: "console", enabled: true }],
    skills: {},
    mcp: { enabled: true, transport: "stdio" },
  };
  const terminal = new InteractiveConsole({ config, save() {}, handlers: {} });
  const answers = ["1", "", "4", "4", "3", "", "", ""]; // QuickStart, skip provider/channels/skills, enable web and MCP
  let recoveryPrompt;
  terminal.ask = async (prompt) => {
    if (prompt.startsWith("¿Probar el proveedor")) return "s";
    if (prompt.startsWith("Recuperación del proveedor")) {
      recoveryPrompt = prompt;
      return "2";
    }
    return answers.shift();
  };
  terminal.verifyProvider = async () => { throw new Error("provider unavailable"); };

  const result = await terminal.onboard();
  assert.match(result, /Setup completado/);
  assert.equal(config.setupComplete, true);
  assert.equal(recoveryPrompt, [
    "Recuperación del proveedor",
    "│  1) Reconfigurar proveedor",
    "│  2) Continuar sin verificar",
    "│  3) Cancelar setup",
    "└  Selección: ",
  ].join("\n"));
});

test("configure menu does not print the configuration overview", async () => {
  let overviewCalls = 0;
  const terminal = new InteractiveConsole({
    config: {
      name: "Harvis",
      provider: { baseUrl: "http://localhost:1234/v1", model: "", apiKey: "" },
    },
    save() {},
    handlers: {
      configuration: () => {
        overviewCalls += 1;
        return "private configuration overview";
      },
    },
  });
  terminal.ask = async () => "0";
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(" "));
  try {
    await terminal.configure([]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(overviewCalls, 0);
  assert.doesNotMatch(output.join("\n"), /private configuration overview|localhost:1234/);
});

test("configures Telegram credentials and authorizes users without echoing the token", async () => {
  const config = {
    name: "Harvis",
    provider: { baseUrl: "http://localhost:1234/v1", model: "local", apiKey: "" },
    channels: [{ type: "telegram", enabled: true }],
  };
  const authorized = [];
  let saves = 0;
  const terminal = new InteractiveConsole({
    config,
    save: () => { saves += 1; },
    handlers: {
      authorizeChannel: (type, id) => {
        authorized.push([type, id]);
        return "contact authorized";
      },
    },
  });

  const tokenResult = await terminal.configure(["channel", "telegram", "token", "private-token"]);
  const authorizationResult = await terminal.configure(["channel", "telegram", "allow", "123456"]);

  assert.equal(config.channels[0].token, "private-token");
  assert.equal(saves, 1);
  assert.doesNotMatch(tokenResult, /private-token/);
  assert.equal(authorizationResult, "contact authorized");
  assert.deepEqual(authorized, [["telegram", "123456"]]);
});

test("configure menu can install WhatsApp and toggle channels and skills", async () => {
  const calls = [];
  const terminal = new InteractiveConsole({
    config: {
      name: "Harvis",
      provider: { name: "lmstudio", baseUrl: "http://localhost:1234/v1", model: "", apiKey: "" },
    },
    save() {},
    handlers: {
      configuration: () => "settings",
      channels: () => "- console: activo",
      skills: () => "- sample: habilitada",
      installChannel: async (name) => `installed ${name}`,
      setChannel: async (...args) => calls.push(["channel", ...args]),
      setSkill: async (...args) => calls.push(["skill", ...args]),
    },
  });
  const answers = ["2", "install whatsapp", "si"];
  terminal.ask = async () => answers.shift();
  terminal.confirmInstall = async () => answers.shift() === "si";

  assert.match(await terminal.configure([]), /installed whatsapp/);
  const channelTerminal = new InteractiveConsole({
    config: terminal.config,
    save() {},
    handlers: {
      channels: () => "- whatsapp: activo",
      setChannel: async (...args) => calls.push(["channel", ...args]),
    },
  });
  channelTerminal.ask = async () => "disable whatsapp";
  await channelTerminal.configure(["channels"]);
  assert.deepEqual(calls, [["channel", "whatsapp", false]]);

  const skillsTerminal = new InteractiveConsole({
    config: terminal.config,
    save() {},
    handlers: {
      configuration: () => "settings",
      channels: () => "",
      skills: () => "- sample: habilitada",
      setSkill: async (...args) => calls.push(["skill", ...args]),
    },
  });
  skillsTerminal.ask = async () => "disable sample";
  await skillsTerminal.configure(["skills"]);
  assert.deepEqual(calls, [
    ["channel", "whatsapp", false],
    ["skill", "sample", false],
  ]);
});

test("WhatsApp setup configures an international allowlist number and supports QR linking", async () => {
  const calls = [];
  const terminal = new InteractiveConsole({
    config: {},
    save() {},
    handlers: {
      configureWhatsAppNumber: async (number) => {
        calls.push(["number", number]);
        return "Número internacional guardado.";
      },
      linkWhatsApp: async () => {
        calls.push(["link"]);
        return "QR listo.";
      },
    },
  });

  assert.equal(
    await terminal.configureChannel(["whatsapp", "number", "+14155552671"]),
    "Número internacional guardado.",
  );
  assert.equal(await terminal.configureChannel(["whatsapp", "link"]), "QR listo.");
  assert.deepEqual(calls, [
    ["number", "+14155552671"],
    ["link"],
  ]);
});

test("WhatsApp number configuration requires international E.164 format", () => {
  assert.equal(normalizeInternationalPhoneNumber("+1 (415) 555-2671"), "+14155552671");
  assert.equal(normalizeInternationalPhoneNumber("+442071838750"), "+442071838750");
  assert.throws(
    () => normalizeInternationalPhoneNumber("4155552671"),
    /formato internacional E.164/,
  );
  assert.throws(
    () => normalizeInternationalPhoneNumber("+0123456789"),
    /formato internacional E.164/,
  );
  assert.throws(
    () => normalizeInternationalPhoneNumber("+1234567"),
    /formato internacional E.164/,
  );
});
