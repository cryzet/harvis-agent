import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EdgeTTS } from "node-edge-tts";

const synthesizer = new EdgeTTS({
  voice: "es-ES-ElviraNeural",
  lang: "es-ES",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  timeout: 30_000,
});

export async function synthesizeSpanishSpeech(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("No hay texto para convertir a audio.");
  }
  if (text.length > 4_000) {
    throw new Error("La respuesta supera el límite de 4000 caracteres para audio.");
  }

  const directory = await mkdtemp(join(tmpdir(), "harvis-tts-"));
  const audioPath = join(directory, "respuesta.mp3");
  try {
    await synthesizer.ttsPromise(text, audioPath);
    return await readFile(audioPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
