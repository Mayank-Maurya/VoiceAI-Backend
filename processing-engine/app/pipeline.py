"""Orchestrates a single voice turn: STT -> LLM -> TTS."""

import asyncio
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from fastapi.concurrency import run_in_threadpool

from app.models import llm_runtime, stt_runtime, tts_runtime


@dataclass
class StageTiming:
    """Wall-clock split for one stage (milliseconds)."""

    wait_ms: float  # time spent waiting to acquire the model lock (queueing)
    compute_ms: float  # time spent actually running the model

    @property
    def total_ms(self) -> float:
        return self.wait_ms + self.compute_ms


@dataclass
class TurnResult:
    """The synthesized reply plus per-stage timings.

    Separating `wait` from `compute` lets benchmarks tell GPU time apart from
    queueing: under load `wait` grows while `compute` stays roughly constant.
    """

    audio: bytes
    stt: StageTiming
    llm: StageTiming
    tts: StageTiming
    total_ms: float


async def run_voice_turn(audio_bytes: bytes) -> TurnResult:
    """Take input speech (WAV bytes) and return the spoken reply + timings."""
    turn_start = time.perf_counter()

    user_text, stt = await _transcribe(audio_bytes)
    print(f"\n[USER] {user_text}")

    ai_response, llm = await _run_locked(llm_runtime.lock, llm_runtime.generate_response, user_text)
    print(f"[AI THINKING] -> {ai_response}")

    audio, tts = await _run_locked(tts_runtime.lock, tts_runtime.generate_audio_bytes, ai_response)

    total_ms = _elapsed_ms(turn_start)
    print(
        f"[TIMING] compute STT={stt.compute_ms:.0f} LLM={llm.compute_ms:.0f} "
        f"TTS={tts.compute_ms:.0f}ms | wait STT={stt.wait_ms:.0f} "
        f"LLM={llm.wait_ms:.0f} TTS={tts.wait_ms:.0f}ms | TOTAL={total_ms:.0f}ms\n"
    )

    return TurnResult(audio=audio, stt=stt, llm=llm, tts=tts, total_ms=total_ms)


async def _transcribe(audio_bytes: bytes) -> tuple[str, StageTiming]:
    # SALM reads from a file, so spool the request body to a temp WAV first.
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = Path(tmp.name)

        return await _run_locked(stt_runtime.lock, stt_runtime.transcribe_file, str(tmp_path))
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


async def _run_locked(lock: asyncio.Lock, fn: Callable[..., Any], *args: Any) -> tuple[Any, StageTiming]:
    """Acquire `lock`, run `fn(*args)` in a worker thread, and time both phases."""
    wait_start = time.perf_counter()
    async with lock:
        wait_ms = _elapsed_ms(wait_start)
        compute_start = time.perf_counter()
        result = await run_in_threadpool(fn, *args)
        compute_ms = _elapsed_ms(compute_start)
    return result, StageTiming(wait_ms=wait_ms, compute_ms=compute_ms)


def _elapsed_ms(start: float) -> float:
    return (time.perf_counter() - start) * 1000
