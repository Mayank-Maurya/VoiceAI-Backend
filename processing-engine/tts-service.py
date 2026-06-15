"""Standalone TTS streaming service.

Run:
    PYTHONPATH=. python tts_service.py

Or:
    PYTHONPATH=. uvicorn tts_service:app --host 0.0.0.0 --port 7002
"""
import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.models.tts import TtsRuntime

TTS_PORT = int(os.getenv("TTS_PORT", "7002"))

runtime = TtsRuntime()
gpu_lock = asyncio.Lock()

@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_in_threadpool(runtime.load)
    yield

app = FastAPI(title="VoiceAI TTS Streaming Service", lifespan=lifespan)

class TtsRequest(BaseModel):
    text: str

@app.get("/health")
async def health():
    return {"ok": True, "model": "kokoro-82m", "loaded": runtime.pipeline is not None}


@app.post("/tts/stream")
async def tts_stream(req: TtsRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")

    async def generate():
        async with gpu_lock:
            for chunk in await run_in_threadpool(lambda: list(runtime.generate_audio_chunks(text))):
                yield chunk

    return StreamingResponse(generate(), media_type="application/octet-stream")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=TTS_PORT)