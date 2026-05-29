import dotenv from "dotenv";

dotenv.config();

// --- HTTP / WebSocket server ---
export const PORT = Number(process.env.PORT ?? 3000);
export const WS_PATH = "/ws/audio";

// --- Downstream processing engine (STT -> LLM -> TTS) ---
export const PROCESSING_ENGINE_URL =
    process.env.PROCESSING_ENGINE_URL ?? "http://192.168.1.7:7001";

// --- Audio format: 16 kHz, 16-bit (2 bytes per sample), mono PCM ---
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;

// --- VAD operates on fixed 100 ms frames ---
export const VAD_FRAME_MS = 100;
export const VAD_FRAME_SAMPLES = (SAMPLE_RATE / 1000) * VAD_FRAME_MS;
export const VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * BYTES_PER_SAMPLE;

// Utterances shorter than this are treated as noise and discarded.
export const MIN_UTTERANCE_BYTES = VAD_FRAME_BYTES * 3;
