import assert from "node:assert/strict";
import test from "node:test";
import {
  isPublicAddress,
  requestPublicPage,
  scrapeWebPage,
  searchWeb,
  validatePublicUrl,
} from "../src/web-tools.js";

test("searches DuckDuckGo and returns parsed result links and snippets", async () => {
  const html = `
    <div class="result">
      <a class="result__a" href="https://example.org/article">Example &amp; news</a>
      <a class="result__snippet">A current result.</a>
    </div>`;
  const result = await searchWeb("latest news", {
    web: { searchEnabled: true, searchProvider: "duckduckgo", maxResults: 5 },
  }, {
    fetchImpl: async () => new Response(html, { status: 200 }),
  });
  assert.match(result, /Example & news/);
  assert.match(result, /https:\/\/example\.org\/article/);
  assert.match(result, /A current result\./);
});

test("rejects local, private, and non-HTTP URLs before downloading", () => {
  for (const address of [
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://192.168.1.1/",
    "file:///etc/passwd",
    "http://example.org:8080/",
  ]) {
    assert.equal(validatePublicUrl(address), null, address);
  }
  assert.equal(isPublicAddress("127.0.0.1"), false);
  assert.equal(isPublicAddress("10.1.2.3"), false);
  assert.equal(isPublicAddress("8.8.8.8"), true);
});

test("blocks hostnames that resolve to private addresses", async () => {
  let requestedPage = false;
  await assert.rejects(
    requestPublicPage(new URL("https://public.example/page"), {
      lookupHost: async () => [{ address: "10.0.0.4", family: 4 }],
      requestPage: async () => {
        requestedPage = true;
        return {};
      },
    }),
    /red no pública/,
  );
  assert.equal(requestedPage, false);
});

test("validates every redirect and bounds the response content type and size", async () => {
  let calls = 0;
  await assert.rejects(
    requestPublicPage(new URL("https://public.example/page"), {
      lookupHost: async () => [{ address: "8.8.8.8", family: 4 }],
      requestPage: async () => {
        calls += 1;
        return { status: 302, location: "http://127.0.0.1/private" };
      },
    }),
    /URL no permitida/,
  );
  assert.equal(calls, 1);

  await assert.rejects(
    requestPublicPage(new URL("https://public.example/page"), {
      lookupHost: async () => [{ address: "8.8.8.8", family: 4 }],
      requestPage: async () => ({
        status: 200,
        contentType: "application/octet-stream",
        body: Buffer.from("not html"),
      }),
    }),
    /no devuelve una página HTML/,
  );
});

test("extracts readable text while excluding scripts and navigation", async () => {
  const result = await scrapeWebPage("https://example.org/article", {
    request: async () => `
      <html><head><title>News &amp; updates</title><script>secret()</script></head>
      <body><nav>menu</nav><article><h1>Headline</h1><p>Useful text.</p></article></body></html>`,
  });
  assert.match(result, /News & updates/);
  assert.match(result, /Headline/);
  assert.match(result, /Useful text/);
  assert.doesNotMatch(result, /secret|menu/);
});

test("requires a Brave API key and reports provider HTTP errors", async () => {
  const config = {
    web: {
      searchEnabled: true,
      searchProvider: "brave",
      searchApiKey: "",
      maxResults: 5,
    },
  };
  await assert.rejects(searchWeb("query", config), /necesita una API key/);
  config.web.searchApiKey = "test-key";
  await assert.rejects(
    searchWeb("query", config, {
      fetchImpl: async () => new Response("error", { status: 403 }),
    }),
    /HTTP 403/,
  );
});
