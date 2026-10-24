import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP stdio server exposes working, profile-scoped skill tools", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "harvis-mcp-"));
  const appData = join(profile, "AppData");
  const paths = {
    appData,
    server: fileURLToPath(new URL("../src/mcp-server.js", import.meta.url)),
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [paths.server],
    env: { ...process.env, APPDATA: appData },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "harvis-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  t.after(async () => {
    await client.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  });

  await client.connect(transport);
  const discovered = await client.listTools();
  assert.ok(discovered.tools.some(({ name }) => name === "create_skill"));
  assert.ok(discovered.tools.some(({ name }) => name === "web_search"));
  assert.ok(discovered.tools.some(({ name }) => name === "web_scrape"));
  const result = await client.callTool({
    name: "create_skill",
    arguments: { name: "mcp-example", instructions: "Answer simply." },
  });
  assert.notEqual(result.isError, true);
  const skills = await client.callTool({ name: "list_skills", arguments: {} });
  assert.match(skills.content[0].text, /mcp-example/);
});
