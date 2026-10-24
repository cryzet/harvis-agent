export async function getAvailableModels(
  { baseUrl, apiKey, providerName },
  { fetchImpl = fetch } = {},
) {
  const endpoints = getModelEndpoints(baseUrl, providerName);
  const failures = [];

  for (const endpoint of endpoints) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      failures.push(`${endpoint}: ${error.message}`);
      continue;
    }
    if (!response.ok) {
      if (response.status === 404 || response.status === 405) {
        failures.push(`${endpoint}: HTTP ${response.status}`);
        continue;
      }
      throw new Error(`No se pudieron consultar modelos en ${endpoint} (HTTP ${response.status}).`);
    }

    const body = await response.json();
    const models = parseModels(body);
    if (models.length) return models;
  }

  if (failures.length === endpoints.length) {
    throw new Error(`No se pudieron consultar modelos (${failures.join("; ")}).`);
  }
  return [];
}

export function getModelEndpoints(baseUrl, providerName) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("La URL del proveedor no es válida.");
  }
  base.pathname = base.pathname.replace(/\/+$/, "");
  base.search = "";
  base.hash = "";
  const baseModels = new URL(`${base.pathname}/models`, base);
  const endpoints = [];

  if (providerName === "lmstudio") {
    if (/\/api\/v1$/i.test(base.pathname)) {
      endpoints.push(baseModels);
    } else {
      endpoints.push(new URL("/api/v1/models", base));
    }
  }
  endpoints.push(baseModels);
  if (providerName === "lmstudio") {
    endpoints.push(new URL("/v1/models", base));
  }
  return [...new Set(endpoints.map((endpoint) => endpoint.href))];
}

export function getChatCompletionsUrl({ baseUrl, providerName }) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("La URL del proveedor no es válida.");
  }
  base.search = "";
  base.hash = "";
  let pathname = base.pathname.replace(/\/+$/, "");
  if (providerName === "lmstudio") {
    pathname = pathname.replace(/\/api\/v1$/i, "");
    if (!/\/v1$/i.test(pathname)) pathname = `${pathname}/v1`;
  }
  return `${base.origin}${pathname}/chat/completions`;
}

function parseModels(body) {
  if (Array.isArray(body?.models)) {
    return body.models
      .filter((model) => model && (model.type === undefined || model.type === "llm"))
      .map((model) => model.key ?? model.id ?? model.model)
      .filter((id) => typeof id === "string" && id.length > 0);
  }
  if (Array.isArray(body?.data)) {
    return body.data
      .map((model) => model?.id ?? model?.key ?? model?.model)
      .filter((id) => typeof id === "string" && id.length > 0);
  }
  return [];
}
