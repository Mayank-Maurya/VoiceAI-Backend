"""Orchestrates a single voice turn: STT -> LLM -> TTS."""

import tempfile
from pathlib import Path

from fastapi.concurrency import run_in_threadpool

from app.models import llm_runtime, stt_runtime, tts_runtime


async def run_voice_turn(audio_bytes: bytes) -> bytes:
    """Take input speech (WAV bytes) and return the spoken reply (WAV bytes)."""
    user_text = await _transcribe(audio_bytes)
    print(f"\n[USER] {user_text}")

    ai_response = await _respond(user_text)
    print(f"[AI THINKING] -> {ai_response}\n")

    return await _synthesize(ai_response)


async def _transcribe(audio_bytes: bytes) -> str:
    # SALM reads from a file, so spool the request body to a temp WAV first.
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = Path(tmp.name)

        async with stt_runtime.lock:
            return await run_in_threadpool(stt_runtime.transcribe_file, str(tmp_path))
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


async def _respond(user_text: str) -> str:
    async with llm_runtime.lock:
        return await run_in_threadpool(llm_runtime.generate_response, user_text)


async def _synthesize(text: str) -> bytes:
    async with tts_runtime.lock:
        return await run_in_threadpool(tts_runtime.generate_audio_bytes, text)
