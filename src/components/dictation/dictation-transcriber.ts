import type { ProgressInfo } from "@huggingface/transformers";
import type { DictationLanguage } from "./use-dictation";

interface TranscriptionOutput {
  text?: string;
}

interface Transcriber {
  (audio: Float32Array, options: Record<string, unknown>): Promise<TranscriptionOutput>;
  dispose?: () => Promise<void>;
}

const DICTATION_MODEL_IDLE_UNLOAD_MS = 5 * 60 * 1000;

let transcriberInstance: Transcriber | null = null;
let transcriberPromise: Promise<Transcriber> | null = null;
let idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;
let activeTranscriptions = 0;
let webGpuFailed = false;

function isAppleWebKitBrowser(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const userAgent = navigator.userAgent;
  const vendor = navigator.vendor || "";
  return vendor.includes("Apple")
    && !userAgent.includes("Chrome")
    && !userAgent.includes("Android");
}

function hasWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && !webGpuFailed && !isAppleWebKitBrowser();
}

async function canUseWebGpu(): Promise<boolean> {
  if (!hasWebGpu()) {
    return false;
  }
  const gpu = navigator.gpu;
  if (!gpu) {
    return false;
  }
  try {
    return await gpu.requestAdapter() !== null;
  } catch {
    return false;
  }
}

async function createTranscriber(
  onProgress?: (progress: ProgressInfo) => void,
  forceWasm = false,
): Promise<Transcriber> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  const wasmBackend = env.backends.onnx.wasm;
  if (isAppleWebKitBrowser() && wasmBackend) {
    wasmBackend.numThreads = 1;
    wasmBackend.proxy = false;
  }

  const DICTATION_MODEL_ID = "Xenova/whisper-tiny";

  const options: Record<string, unknown> = {
    progress_callback: onProgress,
  };

  const useWebGpu = !forceWasm && await canUseWebGpu();
  if (useWebGpu) {
    options["device"] = "webgpu";
    options["dtype"] = {
      encoder_model: "fp32",
      decoder_model_merged: "q4",
    };
  } else {
    options["device"] = "wasm";
    options["dtype"] = {
      encoder_model: "fp32",
      decoder_model_merged: "fp32",
    };
  }

  try {
    return await pipeline("automatic-speech-recognition", DICTATION_MODEL_ID, options) as Transcriber;
  } catch (error) {
    if (!hasWebGpu()) {
      throw error;
    }
    webGpuFailed = true;
    return await createTranscriber(onProgress, true);
  }
}

function clearIdleUnloadTimer(): void {
  if (idleUnloadTimer) {
    clearTimeout(idleUnloadTimer);
    idleUnloadTimer = null;
  }
}

function scheduleIdleUnload(): void {
  clearIdleUnloadTimer();
  if (!transcriberInstance || activeTranscriptions > 0) {
    return;
  }
  idleUnloadTimer = setTimeout(() => {
    if (activeTranscriptions > 0) {
      scheduleIdleUnload();
      return;
    }
    const transcriber = transcriberInstance;
    transcriberInstance = null;
    transcriberPromise = null;
    void transcriber?.dispose?.().catch((error: unknown) => {
      console.warn("Failed to unload dictation model", error);
    });
  }, DICTATION_MODEL_IDLE_UNLOAD_MS);
}

function getTranscriber(onProgress?: (progress: ProgressInfo) => void, forceWasm = false): Promise<Transcriber> {
  clearIdleUnloadTimer();
  if (forceWasm) {
    transcriberPromise = createTranscriber(onProgress, true).then((transcriber) => {
      transcriberInstance = transcriber;
      return transcriber;
    });
  } else {
    transcriberPromise ??= createTranscriber(onProgress).then((transcriber) => {
      transcriberInstance = transcriber;
      return transcriber;
    });
  }
  return transcriberPromise;
}

function getLanguage(language: DictationLanguage): string | null {
  switch (language) {
    case "english":
      return "english";
    case "spanish":
      return "spanish";
    default:
      return null;
  }
}

export async function transcribeDictationAudio(
  audio: Float32Array,
  language: DictationLanguage,
  onProgress?: (progress: ProgressInfo) => void,
): Promise<string> {
  const options = {
    top_k: 0,
    do_sample: false,
    chunk_length_s: 30,
    stride_length_s: 5,
    task: "transcribe",
    language: getLanguage(language),
  };

  activeTranscriptions += 1;
  clearIdleUnloadTimer();
  try {
    const transcriber = await getTranscriber(onProgress);
    const output = await transcriber(audio, options);
    return output.text?.trim() ?? "";
  } catch (error) {
    if (!hasWebGpu()) {
      throw error;
    }
    webGpuFailed = true;
    const transcriber = await getTranscriber(onProgress, true);
    const output = await transcriber(audio, options);
    return output.text?.trim() ?? "";
  } finally {
    activeTranscriptions = Math.max(0, activeTranscriptions - 1);
    scheduleIdleUnload();
  }
}
