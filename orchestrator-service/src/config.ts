import dotenv from "dotenv";

dotenv.config();

const REMOTE_IP = process.env.REMOTE_IP ?? "192.168.1.3";

// --- HTTP / WebSocket server ---
export const PORT = Number(process.env.PORT ?? 3000);
export const WS_PATH = "/ws/audio";

// --- Audio format: 16 kHz, 16-bit (2 bytes per sample), mono PCM ---
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;

// --- Energy gate frames (100 ms each) ---
export const VAD_FRAME_MS = 100;
export const VAD_FRAME_SAMPLES = (SAMPLE_RATE / 1000) * VAD_FRAME_MS;
export const VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * BYTES_PER_SAMPLE;

export const RMS_SPEECH_THRESHOLD = Number(process.env.RMS_SPEECH_THRESHOLD ?? 600);

// After speech stops, keep forwarding this many silence frames (~100ms each) to
// the STT so the buffer carries the speaker's trailing acoustics. Smart Turn
// needs that trailing context to tell "done" from "just pausing".
export const SILENCE_TAIL_FRAMES = Number(process.env.SILENCE_TAIL_FRAMES ?? 8);

// --- Downstream services ---
export const VLLM_BASE_URL = process.env.VLLM_BASE_URL ?? `http://${REMOTE_IP}:8001`;
export const TTS_STREAM_URL = process.env.TTS_STREAM_URL ?? `http://${REMOTE_IP}:7002`;
export const STT_WS_URL = process.env.STT_WS_URL ?? `ws://${REMOTE_IP}:7003`;

export const VLLM_MODEL_ID =
    process.env.VLLM_MODEL_ID ?? "Qwen/Qwen2.5-3B-Instruct";

export const LLM_MAX_NEW_TOKENS = Number(process.env.LLM_MAX_NEW_TOKENS ?? 256);
export const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.6);

export const LLM_SYSTEM_PROMPT =
    process.env.LLM_SYSTEM_PROMPT ??
   `You are a helpful, conversational voice assistant. Your responses are read aloud by a text-to-speech engine, so you must format them strictly for natural speech.
CORE RULES:
1. Be extremely concise. Limit every response to 1 or 2 short sentences.
2. Speak naturally. Use casual, everyday spoken English. 
3. Use human fillers and acknowledgments. If the user says "stop," interrupts, or gives a brief confirmation, reply with short, natural conversational words like "Umm," "Okay," "Got it," "Right," or "Hmm." 
4. Handle interruptions gracefully. If the user tells you to stop, simply say "Okay" or "Got it" and wait for their next prompt. Do not add any other words.
5. No formatting. Never use bullet points, bold text, asterisks, brackets, or markdown.
6. Spell out symbols. Write out numbers, currency, and symbols as words (e.g., "ten dollars" instead of "$10").
7. Cut AI filler. Answer directly. Never use robotic intro phrases like "I can help with that" or "As an AI.`;
