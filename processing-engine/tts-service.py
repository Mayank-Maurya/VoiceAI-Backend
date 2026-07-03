"""Standalone TTS streaming service with pluggable backends.

Backend is chosen at startup via env:
    TTS_PROVIDER=kokoro        (default)  local Kokoro-82M
    TTS_PROVIDER=elevenlabs               cloud, needs ELEVENLABS_API_KEY
                                          (falls back to Kokoro if the key is unset)

Run:
    PYTHONPATH=. python tts-service.py
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.models.tts import TtsRuntime
from app.tts_providers import ElevenLabsProvider, KokoroProvider, RumikProvider

TTS_PORT = int(os.getenv("TTS_PORT", "7002"))

runtime = TtsRuntime()
state: dict = {"provider": None, "name": "none"}

@asynccontextmanager
async def lifespan(app: FastAPI):
    name = os.getenv("TTS_PROVIDER", "kokoro").lower()

    if name == "elevenlabs" and os.getenv("ELEVENLABS_API_KEY"):
        state["provider"] = ElevenLabsProvider(
            api_key=os.environ["ELEVENLABS_API_KEY"],
            voice_id=os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
            model_id=os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2_5"),
        )
        state["name"] = "elevenlabs"
    elif name == "rumik" and os.getenv("RUMIK_API_KEY"):
        state["provider"] = RumikProvider(
            api_key=os.environ["RUMIK_API_KEY"],
            model=os.getenv("RUMIK_MODEL", "mulberry"),
            description=os.getenv(
                "RUMIK_DESCRIPTION",
                "a warm, friendly voice, smooth timbre, natural conversational pacing",
            ),
            speaker=os.getenv("RUMIK_SPEAKER", "speaker_1"),
            use_emotion_tags=os.getenv("RUMIK_EMOTION_TAGS", "on").lower()
            not in ("0", "off", "false", "no"),
        )
        state["name"] = "rumik"
    else:
        if name in ("elevenlabs", "rumik"):
            print(f"TTS_PROVIDER={name} but its API key is unset — using Kokoro.", flush=True)
        # Only load Kokoro into VRAM when it's actually the backend.
        await run_in_threadpool(runtime.load)
        state["provider"] = KokoroProvider(runtime)
        state["name"] = "kokoro"

    print(f"TTS provider: {state['name']}", flush=True)
    yield


app = FastAPI(title="VoiceAI TTS Streaming Service", lifespan=lifespan)


class TtsRequest(BaseModel):
    text: str
    tone: str | None = None


@app.get("/health")
async def health():
    return {"ok": True, "provider": state["name"]}


@app.post("/tts/stream")
async def tts_stream(req: TtsRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")

    return StreamingResponse(
        state["provider"].framed_stream(text, req.tone),
        media_type="application/octet-stream",
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=TTS_PORT)
