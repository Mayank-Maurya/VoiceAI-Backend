"""Standalone STT streaming service over WebSocket.

Run:
    PYTHONPATH=. python stt_service.py
"""

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool

from app.models.stt import SttRuntime

STT_PORT = int(os.getenv("STT_PORT", "7003"))
SAMPLE_RATE = 16000

TRANSCRIBE_INTERVAL = 0.5
STABLE_DURATION = 0.3

runtime = SttRuntime()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_in_threadpool(runtime.load)
    yield


app = FastAPI(title="VoiceAI STT Streaming Service", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"ok": True, "model": "faster-whisper", "loaded": runtime.model is not None}


@app.websocket("/ws/stt")
async def stt_websocket(ws: WebSocket):
    await ws.accept()

    audio_buffer = np.array([], dtype=np.float32)
    last_transcript = ""
    last_change_at = 0.0
    silence_signaled = False
    has_audio = False
    transcribe_task: asyncio.Task | None = None

    async def do_transcribe():
        nonlocal last_transcript, last_change_at, audio_buffer

        if len(audio_buffer) < SAMPLE_RATE * 0.3:
            return

        audio_snap = audio_buffer.copy()

        text = await run_in_threadpool(runtime.transcribe_buffer, audio_snap)

        if text != last_transcript:
            last_transcript = text
            last_change_at = time.monotonic()
            await ws.send_json({"text": text, "is_final": False})

    async def check_final():
        nonlocal last_transcript, last_change_at, audio_buffer, silence_signaled, has_audio

        if not last_transcript:
            return

        now = time.monotonic()
        stable_for = now - last_change_at

        if stable_for >= STABLE_DURATION and silence_signaled:
            if len(audio_buffer) >= SAMPLE_RATE * 0.3:
                text = await run_in_threadpool(
                    runtime.transcribe_buffer, audio_buffer.copy()
                )
                if text:
                    last_transcript = text

            await ws.send_json({"text": last_transcript, "is_final": True})

            audio_buffer = np.array([], dtype=np.float32)
            last_transcript = ""
            last_change_at = 0.0
            silence_signaled = False
            has_audio = False

    async def transcription_loop():
        while True:
            await asyncio.sleep(TRANSCRIBE_INTERVAL)
            if has_audio and len(audio_buffer) >= SAMPLE_RATE * 0.3:
                await do_transcribe()
                await check_final()

    transcribe_task = asyncio.create_task(transcription_loop())

    try:
        while True:
            msg = await ws.receive()

            if msg["type"] == "websocket.disconnect":
                break

            if "bytes" in msg and msg["bytes"]:
                pcm16 = np.frombuffer(msg["bytes"], dtype=np.int16)
                float32 = pcm16.astype(np.float32) / 32768.0
                audio_buffer = np.concatenate([audio_buffer, float32])
                has_audio = True
                silence_signaled = False

            elif "text" in msg and msg["text"]:
                try:
                    control = json.loads(msg["text"])
                    if control.get("silence"):
                        silence_signaled = True
                        await check_final()
                except json.JSONDecodeError:
                    pass

    except WebSocketDisconnect:
        pass
    finally:
        if transcribe_task:
            transcribe_task.cancel()
            try:
                await transcribe_task
            except asyncio.CancelledError:
                pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=STT_PORT)
