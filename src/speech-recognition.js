import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OggOpusDecoder } from "ogg-opus-decoder";

const require = createRequire(import.meta.url);
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin";
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modelPath = join(projectRoot, "models", "ggml-tiny.bin");
const minimumModelBytes = 60 * 1024 * 1024;
let whisperContextPromise;
let whisperApi;
let transcriptionQueue = Promise.resolve();
let modelDownloadPromise;

export function ensureWhisperModel({ onProgress = () => {} } = {}) {
  modelDownloadPromise ??= downloadWhisperModel(onProgress).catch((error) => {
    modelDownloadPromise = undefined;
    throw error;
  });
  return modelDownloadPromise;
}

export function transcribeVoiceMessage(audioBuffer) {
  const task = transcriptionQueue.catch(() => {})
    .then(() => transcribeVoiceMessageInQueue(audioBuffer));
  transcriptionQueue = task;
  return task;
}

async function transcribeVoiceMessageInQueue(audioBuffer) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error("El audio recibido está vacío o no es válido.");
  }
  if (audioBuffer.length > 16 * 1024 * 1024) {
    throw new Error("El audio supera el límite de 16 MB.");
  }

  const decoder = new OggOpusDecoder();
  let decoded;
  try {
    await decoder.ready;
    decoded = await decoder.decodeFile(audioBuffer);
  } finally {
    decoder.free();
  }
  const { channelData, sampleRate } = decoded ?? {};
  if (!Array.isArray(channelData) || !channelData.length || !Number.isFinite(sampleRate)) {
    throw new Error("No se pudo decodificar el audio recibido.");
  }
  const monoAudio = mixToMono(channelData);
  if (!monoAudio.length || monoAudio.length / sampleRate > 300) {
    throw new Error("El mensaje de voz debe durar menos de 5 minutos.");
  }
  const audio16k = resample(monoAudio, sampleRate, 16_000);
  const context = await getWhisperContext();
  const result = await getWhisperApi().transcribeAsync(context, {
    pcmf32: audio16k,
    language: "es",
    n_threads: 4,
    no_timestamps: true,
  });
  const text = (result?.segments ?? [])
    .map((segment) => Array.isArray(segment) ? segment[2] : segment.text)
    .join("")
    .trim();
  if (!text) throw new Error("No se reconocieron palabras en el mensaje de voz.");
  return text;
}

async function getWhisperContext() {
  whisperContextPromise ??= ensureWhisperModel()
    .then((path) => getWhisperApi().createWhisperContext({
      model: path,
      use_gpu: false,
      no_prints: true,
    }));
  try {
    return await whisperContextPromise;
  } catch (error) {
    whisperContextPromise = undefined;
    throw error;
  }
}

async function downloadWhisperModel(onProgress) {
  const modelDirectory = dirname(modelPath);
  await mkdir(modelDirectory, { recursive: true, mode: 0o700 });
  try {
    if ((await stat(modelPath)).size < minimumModelBytes) {
      await rm(modelPath, { force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    if ((await stat(modelPath)).size >= minimumModelBytes) return modelPath;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporaryPath = `${modelPath}.download`;
  await rm(temporaryPath, { force: true });
  onProgress("Descargando el modelo Whisper Tiny (aprox. 75 MB)…");
  try {
    const response = await fetch(modelUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`No se pudo descargar el modelo Whisper (${response.status}).`);
    }
    const totalBytes = Number(response.headers.get("content-length")) || undefined;
    let downloadedBytes = 0;
    let nextProgressAt = 5 * 1024 * 1024;
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        downloadedBytes += chunk.length;
        if (downloadedBytes >= nextProgressAt) {
          const downloaded = Math.floor(downloadedBytes / (1024 * 1024));
          const total = totalBytes ? ` de ${Math.ceil(totalBytes / (1024 * 1024))} MB` : " MB";
          onProgress(`Whisper: ${downloaded}${total} descargados.`);
          nextProgressAt += 5 * 1024 * 1024;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      response.body,
      progress,
      createWriteStream(temporaryPath, { flags: "w", mode: 0o600 }),
    );
    if ((await stat(temporaryPath)).size < minimumModelBytes) {
      throw new Error("El archivo descargado del modelo Whisper está incompleto.");
    }
    await rename(temporaryPath, modelPath);
    onProgress("Modelo Whisper Tiny descargado y listo.");
    return modelPath;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error("La descarga de Whisper superó 10 minutos. Comprueba la conexión a huggingface.co e inténtalo de nuevo.", { cause: error });
    }
    throw error;
  }
}

function getWhisperApi() {
  if (whisperApi) return whisperApi;
  try {
    whisperApi = require("whisper-cpp-node");
    return whisperApi;
  } catch (error) {
    throw new Error(
      `No está disponible el motor Whisper para esta plataforma o arquitectura: ${error.message}`,
      { cause: error },
    );
  }
}

function mixToMono(channels) {
  const length = Math.min(...channels.map((channel) => channel.length));
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) mono[i] += channel[i] / channels.length;
  }
  return mono;
}

function resample(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[i] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}
