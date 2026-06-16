"""Runtime configuration, sourced from environment variables."""

import os

# --- Speech-to-text (faster-whisper) ---
STT_MODEL_NAME = os.getenv("STT_MODEL_NAME", "medium")

# --- Text-to-speech (Kokoro-82M) ---
TTS_LANG_CODE = "a"  # American English
TTS_VOICE = "af_heart"
TTS_SAMPLE_RATE = 24000
TTS_SPEED = 1.0
