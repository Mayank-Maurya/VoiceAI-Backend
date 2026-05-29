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
    """Full voice turn: WAV in -> transcribe -> reason -> synthesize -> WAV out."""
    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio body")

    wav_bytes = await run_voice_turn(audio_bytes)
    return Response(content=wav_bytes, media_type="audio/wav")
