import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileToolHandlers } from "../src/file-tools.js";

test("file tools require approval and limit access to the user home folder", async (t) => {
  const directory = await mkdtemp(join(homedir(), "harvis-file-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "notes.txt");
  await writeFile(target, "contenido privado");
  const handlers = createFileToolHandlers();
  const deniedContext = {
    requestApproval: async () => false,
  };

  await assert.rejects(handlers.read_file({ path: target }, deniedContext), /cancelada/);
  await assert.rejects(
    handlers.read_file({ path: join(homedir(), "..", "outside.txt") }, {
      requestApproval: async () => assert.fail("No se debe pedir aprobación para una ruta externa"),
    }),
    /solo puede gestionar archivos dentro de tu carpeta personal/,
  );
  assert.equal(await readFile(target, "utf8"), "contenido privado");
});

test("approved file operations read, write, list, delete, and send files", async (t) => {
  const directory = await mkdtemp(join(homedir(), "harvis-file-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "notes.txt");
  await writeFile(target, "texto inicial");
  const approvals = [];
  const sent = [];
  const context = {
    requestApproval: async (action) => {
      approvals.push(action);
      return true;
    },
    sendFile: async (file) => sent.push(file),
  };
  const handlers = createFileToolHandlers();

  const tildePath = `~/${target.slice(homedir().length + 1).replaceAll("\\", "/")}`;
  assert.equal(await handlers.read_file({ path: tildePath }, context), "texto inicial");
  assert.match(await handlers.list_files({ path: directory }, context), /notes\.txt/);
  assert.match(await handlers.write_file({ path: target, content: "nuevo texto" }, context), /Archivo guardado/);
  assert.equal(await readFile(target, "utf8"), "nuevo texto");
  assert.match(await handlers.send_file({ path: target, caption: "Adjunto" }, context), /enviado por WhatsApp/);
  assert.equal(sent[0].buffer.toString("utf8"), "nuevo texto");
  assert.equal(sent[0].fileName, "notes.txt");
  assert.match(await handlers.delete_file({ path: target }, context), /Archivo eliminado/);
  assert.equal(approvals.length, 5);
});
