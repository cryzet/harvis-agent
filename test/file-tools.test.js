import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileToolHandlers } from "../src/file-tools.js";

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "harvis-file-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = join(directory, "profile");
  const instructionsFile = join(profile, "Instrucciones.txt");
  const ignoreFile = join(profile, "Ignore.txt");
  await mkdir(profile);
  await writeFile(instructionsFile, "Horario: lunes a viernes.");
  await writeFile(ignoreFile, "");
  return {
    directory,
    handlers: createFileToolHandlers({
      config: {
        name: "Harvis",
        channels: [{ type: "whatsapp", adminNumber: "+14155552670" }],
      },
      paths: { instructionsFile, ignoreFile },
      workDirectory: async () => directory,
    }),
  };
}

test("file operations require the authenticated admin role and remain inside the work directory", async (t) => {
  const { directory, handlers } = await createFixture(t);
  const target = join(directory, "notes.txt");
  await writeFile(target, "contenido privado");

  await assert.rejects(
    handlers.read_file({ path: target }, { role: "client" }),
    /únicamente para el administrador autenticado/,
  );
  await assert.rejects(
    handlers.read_file({ path: join(tmpdir(), "outside.txt") }, { role: "admin" }),
    /Documents\/<nombre>_WorkDir/,
  );
  assert.equal(await readFile(target, "utf8"), "contenido privado");
});

test("admin can read, write, list, delete, and send work-directory files without OTP", async (t) => {
  const { directory, handlers } = await createFixture(t);
  const target = join(directory, "notes.txt");
  await writeFile(target, "texto inicial");
  const sent = [];
  const context = {
    role: "admin",
    sendFile: async (file) => sent.push(file),
  };

  assert.equal(await handlers.read_file({ path: target }, context), "texto inicial");
  assert.match(await handlers.list_files({ path: "." }, context), /notes\.txt/);
  assert.match(await handlers.write_file({ path: target, content: "nuevo texto" }, context), /Archivo guardado/);
  assert.equal(await readFile(target, "utf8"), "nuevo texto");
  assert.match(await handlers.send_file({ path: target, caption: "Adjunto" }, context), /enviado por WhatsApp/);
  assert.equal(sent[0].buffer.toString("utf8"), "nuevo texto");
  assert.equal(sent[0].fileName, "notes.txt");
  assert.match(await handlers.delete_file({ path: target }, context), /Archivo eliminado/);
});

test("admin tools update customer instructions and the ignored-number list", async (t) => {
  const { handlers } = await createFixture(t);
  const context = { role: "admin" };

  assert.equal(
    await handlers.read_client_instructions({}, context),
    "Horario: lunes a viernes.",
  );
  assert.match(
    await handlers.write_client_instructions({ content: "Atendemos de 9 a 5." }, context),
    /actualizado/,
  );
  assert.equal(
    await handlers.read_client_instructions({}, context),
    "Atendemos de 9 a 5.",
  );
  assert.match(
    await handlers.manage_ignored_number({ action: "add", number: "+14155552671" }, context),
    /agregado/,
  );
  await assert.rejects(
    handlers.manage_ignored_number({ action: "add", number: "+14155552670" }, context),
    /no se puede agregar a Ignore.txt el número administrador/i,
  );
  assert.deepEqual(
    (await handlers.manage_ignored_number({ action: "list" }, context)).split("\n"),
    ["+14155552671"],
  );
  await assert.rejects(
    handlers.manage_ignored_number({ action: "add", number: "+14155552672" }, { role: "client" }),
    /únicamente para el administrador autenticado/,
  );
});
