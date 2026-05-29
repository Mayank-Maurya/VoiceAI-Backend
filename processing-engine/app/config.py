"""Runtime configuration, sourced from environment variables."""

import os

# --- Speech-to-text (NVIDIA Canary / SALM) ---
STT_MODEL_NAME = os.getenv("MODEL_NAME", "nvidia/canary-qwen-2.5b")
STT_MAX_NEW_TOKENS = int(os.getenv("MAX_NEW_TOKENS", "128"))

# --- Large language model (Llama 3.2) ---
LLM_MODEL_ID = os.getenv("LLM_MODEL_ID", "meta-llama/Llama-3.2-1B-Instruct")
LLM_MAX_NEW_TOKENS = int(os.getenv("LLM_MAX_NEW_TOKENS", "256"))
LLM_TEMPERATURE = 0.6
# Greedy/deterministic decoding. With a fixed input this yields the same reply
# (and the same length) every run, removing output-length variance from
# benchmarks. Leave off for natural, varied replies in normal use.
LLM_DETERMINISTIC = os.getenv("LLM_DETERMINISTIC", "false").lower() in ("1", "true", "yes")
LLM_SYSTEM_PROMPT = (
    "You are a helpful, conversational voice assistant. Keep answers brief, "
    "natural, and spoken-word friendly. Do not use markdown, emojis, or lists."
)

# --- Text-to-speech (Kokoro-82M) ---
TTS_LANG_CODE = "a"  # American English
TTS_VOICE = "af_heart"  # Default American female Kokoro voice
TTS_SAMPLE_RATE = 24000
TTS_SPEED = 1.0

# --- Auth / server ---
HF_TOKEN = os.getenv("HF_TOKEN")
PORT = int(os.getenv("PORT", "7001"))
