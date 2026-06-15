import dotenv from "dotenv";
import crypto from "node:crypto";

dotenv.config();

// --- Remote GPU machine ---
const REMOTE_IP = process.env.REMOTE_IP ?? "192.168.1.3";

// --- HTTP / WebSocket server ---
export const PORT = Number(process.env.PORT ?? 3000);
export const WS_PATH = "/ws/audio";

// --- Downstream processing engine (STT -> LLM -> TTS) ---
export const PROCESSING_ENGINE_URL =
    process.env.PROCESSING_ENGINE_URL ?? `http://${REMOTE_IP}:7001`;

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

// Short utterances (< this many voice frames) use a faster silence cutoff.
// Default 10 frames = ~1 s of speech. "Yes", "No", "Hello" finish faster.
export const SHORT_UTTERANCE_VOICE_FRAMES = Number(process.env.SHORT_UTTERANCE_VOICE_FRAMES ?? 10);

// Silence frames to end a SHORT utterance (~300 ms). Must be <= SPEECH_END_SILENCE_FRAMES.
export const SHORT_UTTERANCE_SILENCE_FRAMES = Number(process.env.SHORT_UTTERANCE_SILENCE_FRAMES ?? 3);

// Silence frames to end a LONG utterance (~500 ms). This replaces the old default of 8.
export const LONG_UTTERANCE_SILENCE_FRAMES = Number(process.env.LONG_UTTERANCE_SILENCE_FRAMES ?? 5);

// Minimum total voice frames an utterance must contain to be dispatched (~500 ms).
export const MIN_SPEECH_FRAMES = Number(process.env.MIN_SPEECH_FRAMES ?? 5);

function clampVadMode(value: number): 0 | 1 | 2 | 3 {
    const clamped = Math.min(3, Math.max(0, Math.round(value)));
    return clamped as 0 | 1 | 2 | 3;
}

export const RABBITMQ_URL = process.env.RABBITMQ_URL ?? `amqp://voiceai:voiceai_password@${REMOTE_IP}:5672`;

export const ORCHESTRATOR_INSTANCE_ID =
    process.env.ORCHESTRATOR_INSTANCE_ID ?? `orchestrator-${crypto.randomUUID()}`;

export const STT_JOBS_QUEUE = process.env.STT_JOBS_QUEUE ?? "stt.jobs";
export const TTS_JOBS_QUEUE = process.env.TTS_JOBS_QUEUE ?? "tts.jobs";

export const ORCHESTRATOR_REPLY_QUEUE =
    process.env.ORCHESTRATOR_REPLY_QUEUE ?? `orchestrator.replies.${ORCHESTRATOR_INSTANCE_ID}`;

export const STAGE_TIMEOUT_MS = Number(process.env.STAGE_TIMEOUT_MS ?? 30_000);

export const VLLM_BASE_URL = process.env.VLLM_BASE_URL ?? `http://${REMOTE_IP}:8000`;
export const TTS_STREAM_URL = process.env.TTS_STREAM_URL ?? `http://${REMOTE_IP}:7002`;
export const STT_WS_URL = process.env.STT_WS_URL ?? `ws://${REMOTE_IP}:7003`;
export const VLLM_MODEL_ID =
    process.env.VLLM_MODEL_ID ?? "Qwen/Qwen2.5-0.5B-Instruct";

export const LLM_MAX_NEW_TOKENS = Number(process.env.LLM_MAX_NEW_TOKENS ?? 256);
export const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.6);

export const LLM_SYSTEM_PROMPT =
    process.env.LLM_SYSTEM_PROMPT ??
    "You are a helpful, conversational voice assistant. Keep answers brief, natural, and spoken-word friendly. Do not use markdown, emojis, or lists.";
