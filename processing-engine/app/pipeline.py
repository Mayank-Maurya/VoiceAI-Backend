"""Orchestrates a single voice turn: STT -> LLM -> TTS."""

import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi.concurrency import run_in_threadpool

from app.models import llm_runtime, stt_runtime, tts_runtime


@dataclass
class TurnResult:
    """The synthesized reply plus per-stage wall-clock timings (milliseconds).

    Stage timings include any time spent waiting on the per-model lock, so under
    concurrency they reflect real per-request latency (compute + queueing).
    """

    audio: bytes
    stt_ms: float
    llm_ms: float
    tts_ms: float
    total_ms: float


async def run_voice_turn(audio_bytes: bytes) -> TurnResult:
    """Take input speech (WAV bytes) and return the spoken reply + timings."""
    turn_start = time.perf_counter()

    t0 = time.perf_counter()
    user_text = await _transcribe(audio_bytes)
    stt_ms = _elapsed_ms(t0)
    print(f"\n[USER] {user_text}")

    t0 = time.perf_counter()
    ai_response = await _respond(user_text)
    llm_ms = _elapsed_ms(t0)
    print(f"[AI THINKING] -> {ai_response}")

    t0 = time.perf_counter()
    audio = await _synthesize(ai_response)
    tts_ms = _elapsed_ms(t0)

    total_ms = _elapsed_ms(turn_start)
    print(
        f"[TIMING] STT={stt_ms:.0f}ms  LLM={llm_ms:.0f}ms  "
        f"TTS={tts_ms:.0f}ms  TOTAL={total_ms:.0f}ms\n"
    )

    return TurnResult(
        audio=audio,
        stt_ms=stt_ms,
        llm_ms=llm_ms,
        tts_ms=tts_ms,
        total_ms=total_ms,
    )


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


def _elapsed_ms(start: float) -> float:
    return (time.perf_counter() - start) * 1000
