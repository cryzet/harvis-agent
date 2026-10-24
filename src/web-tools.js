import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const maxHtmlBytes = 2 * 1024 * 1024;
const maxRedirects = 3;

export const webToolDefinitions = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Busca información pública actual en la web y devuelve resultados con título, enlace y extracto.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Consulta de búsqueda." },
          count: { type: "integer", minimum: 1, maximum: 10, description: "Máximo de resultados, limitado por la configuración." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_scrape",
      description: "Descarga una página pública HTTP(S) y extrae su texto principal. Rechaza redes locales y privadas.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL pública de la página." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];

export async function searchWeb(query, config, {
  fetchImpl = fetch,
  count,
} = {}) {
  if (!config.web.searchEnabled) throw new Error("La búsqueda web está deshabilitada.");
  const normalizedQuery = validateQuery(query);
  const resultCount = Number.isInteger(count)
    ? Math.max(1, Math.min(count, config.web.maxResults))
    : config.web.maxResults;

  if (config.web.searchProvider === "brave") {
    if (!config.web.searchApiKey) {
      throw new Error("Brave Search necesita una API key. Configúrala en /configure > Web.");
    }
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("count", String(resultCount));
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": config.web.searchApiKey,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Brave Search respondió con HTTP ${response.status}.`);
    const data = await response.json();
    const results = (data.web?.results ?? []).slice(0, resultCount).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.description,
    }));
    return formatResults(normalizedQuery, results);
  }

  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", normalizedQuery);
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/html",
      "User-Agent": "HarvisLite/1.0 (+local assistant web search)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`DuckDuckGo respondió con HTTP ${response.status}.`);
  const html = (await response.text()).slice(0, maxHtmlBytes);
  return formatResults(normalizedQuery, parseDuckDuckGoResults(html, resultCount));
}

export async function scrapeWebPage(input, {
  request = (url) => requestPublicPage(url),
} = {}) {
  const target = validatePublicUrl(input);
  if (!target) throw new Error("La URL debe ser pública y usar HTTP o HTTPS.");
  const html = await request(target);
  return extractReadableText(html);
}

export async function requestPublicPage(initialUrl, {
  lookupHost = lookup,
  requestPage = requestPinned,
} = {}) {
  let current = initialUrl;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const url = validatePublicUrl(current.href);
    if (!url) throw new Error("La página intentó redirigir a una URL no permitida.");
    const addresses = await withTimeout(
      lookupHost(url.hostname, { all: true, verbatim: true }),
      10_000,
      "La resolución DNS excedió el límite de tiempo.",
    );
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error("La página no está disponible porque su host resuelve a una red no pública.");
    }
    const response = await requestPage(url, addresses[0]);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || redirect === maxRedirects) {
        throw new Error("La página excedió el límite de redirecciones.");
      }
      current = new URL(response.location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`La página respondió con HTTP ${response.status}.`);
    }
    if (!/^text\/html\b/i.test(response.contentType ?? "")) {
      throw new Error("La URL no devuelve una página HTML.");
    }
    if (response.body.length > maxHtmlBytes) {
      throw new Error("La página excede el límite de descarga de 2 MB.");
    }
    return response.body.toString("utf8");
  }
  throw new Error("La página excedió el límite de redirecciones.");
}

export function validatePublicUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) ||
      url.username || url.password ||
      !["", "80", "443"].includes(url.port) ||
      isBlockedHostname(url.hostname)) {
    return null;
  }
  return url;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice(7);
      if (isIP(mapped) === 4) return isPublicAddress(mapped);
    }
    const firstGroup = normalized.split(":")[0];
    const first = Number.parseInt(firstGroup || "0", 16);
    return (first & 0xe000) === 0x2000 && !normalized.startsWith("2001:db8:");
  }
  return false;
}

function validateQuery(query) {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("Especifica qué quieres buscar.");
  }
  return query.trim().slice(0, 500);
}

function parseDuckDuckGoResults(html, count) {
  const snippets = [...html.matchAll(/<(?:a|div|span)\b([^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*)>([\s\S]*?)<\/(?:a|div|span)>/gi)]
    .map((match) => stripHtml(match[2]));
  const results = [];
  const pattern = /<a\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    let href;
    try {
      const hrefMatch = match[1].match(/\bhref=["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      const parsed = new URL(decodeHtml(hrefMatch[1]), "https://duckduckgo.com");
      href = parsed.searchParams.get("uddg") ?? parsed.href;
      const resultUrl = new URL(href);
      if (!["http:", "https:"].includes(resultUrl.protocol)) continue;
      results.push({
        title: stripHtml(match[2]),
        url: resultUrl.href,
        snippet: snippets[results.length] ?? "",
      });
    } catch {
      continue;
    }
    if (results.length >= count) break;
  }
  return results;
}

function formatResults(query, results) {
  if (!results.length) return `No encontré resultados web para: ${query}`;
  return `Resultados actuales para "${query}":\n${results.map((item, index) =>
    `${index + 1}. ${item.title}\n   ${item.url}${item.snippet ? `\n   ${item.snippet}` : ""}`,
  ).join("\n")}`;
}

function requestPinned(url, address) {
  return new Promise((resolve, reject) => {
    const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": "HarvisLite/1.0 (+local assistant web extraction)",
        Accept: "text/html",
        "Accept-Encoding": "identity",
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      timeout: 10_000,
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        resolve({
          status: response.statusCode,
          location: response.headers.location,
        });
        return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > maxHtmlBytes) {
          request.destroy(new Error("La página excede el límite de descarga de 2 MB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        contentType: response.headers["content-type"] ?? "",
        body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("La descarga excedió el límite de tiempo.")));
    request.on("error", reject);
    request.end();
  });
}

function extractReadableText(html) {
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const content = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/article|\/section|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeHtml(content).replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const result = [title && `Título: ${title}`, text].filter(Boolean).join("\n\n").slice(0, 20_000);
  if (!result) throw new Error("No se pudo extraer texto legible de la página.");
  return result;
}

function stripHtml(value) {
  return decodeHtml(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function isBlockedHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") ||
      normalized.endsWith(".local") || normalized.endsWith(".internal")) {
    return true;
  }
  if (isIP(normalized)) return !isPublicAddress(normalized);
  return false;
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}
