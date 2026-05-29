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

// --- VAD endpointing / noise-rejection tuning ---
// All thresholds are env-tunable because the right values depend on the mic
// and room. Frame durations below assume VAD_FRAME_MS (100 ms) per frame.

// WebRTC VAD aggressiveness: 0 (NORMAL) .. 3 (VERY_AGGRESSIVE). Higher values
// filter out more non-speech, which reduces false positives.
export const VAD_MODE = clampVadMode(Number(process.env.VAD_MODE ?? 3));

// A frame must exceed this RMS energy (PCM16 scale, 0..32767) to count as
// speech. Rejects low-level ambient noise that auto-gain can amplify.
export const RMS_SPEECH_THRESHOLD = Number(process.env.RMS_SPEECH_THRESHOLD ?? 600);

// Consecutive qualifying voice frames required to START an utterance (~300 ms).
export const SPEECH_START_FRAMES = Number(process.env.SPEECH_START_FRAMES ?? 3);

// Consecutive silence frames required to END an utterance (~800 ms hangover).
export const SPEECH_END_SILENCE_FRAMES = Number(process.env.SPEECH_END_SILENCE_FRAMES ?? 8);

// Minimum total voice frames an utterance must contain to be dispatched (~500 ms).
export const MIN_SPEECH_FRAMES = Number(process.env.MIN_SPEECH_FRAMES ?? 5);

function clampVadMode(value: number): 0 | 1 | 2 | 3 {
    const clamped = Math.min(3, Math.max(0, Math.round(value)));
    return clamped as 0 | 1 | 2 | 3;
}
