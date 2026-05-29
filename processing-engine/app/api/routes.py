"""HTTP API routes."""

from typing import Any

import torch
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from app.config import STT_MODEL_NAME
from app.models import stt_runtime
from app.pipeline import run_voice_turn

router = APIRouter()

@router.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": STT_MODEL_NAME,
        "cuda": torch.cuda.is_available(),
        "loaded": stt_runtime.model is not None,
    }


@router.post("/voice-chat")
async def voice_chat(request: Request) -> Response:
    """Full voice turn: WAV in -> transcribe -> reason -> synthesize -> WAV out.

    Per-stage timings are returned in `X-Timing-*` response headers so callers
    (and the benchmark harness) can see the STT/LLM/TTS breakdown per request.
    """
    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio body")

    result = await run_voice_turn(audio_bytes)
    return Response(
        content=result.audio,
        media_type="audio/wav",
        headers={
            "X-Timing-STT-Ms": f"{result.stt_ms:.1f}",
            "X-Timing-LLM-Ms": f"{result.llm_ms:.1f}",
            "X-Timing-TTS-Ms": f"{result.tts_ms:.1f}",
            "X-Timing-Total-Ms": f"{result.total_ms:.1f}",
        },
    )
