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
from app.models.turn_detector import TurnDetector

STT_PORT = int(os.getenv("STT_PORT", "7003"))
SAMPLE_RATE = 16000

PARTIAL_INTERVAL = 0.7      # seconds between partial (live caption) transcriptions
PARTIAL_WINDOW_SEC = 6.0    # partials transcribe only the trailing N seconds
MIN_AUDIO_SEC = 0.3         # ignore buffers shorter than this
FINALIZE_POLL_SEC = 0.05    # how often the finalize watcher checks the clock

# --- Endpointing windows ---
# When the turn detector IS available (Phase 2):
#   - consult it once silence has held MIN_ENDPOINT (snappy for completed turns)
#   - if it says "not done", wait until MAX_ENDPOINT before committing anyway
MIN_ENDPOINT_SILENCE_SEC = float(os.getenv("MIN_ENDPOINT_SILENCE_MS", "200")) / 1000.0
MAX_ENDPOINT_SILENCE_SEC = float(os.getenv("MAX_ENDPOINT_SILENCE_MS", "2000")) / 1000.0
TURN_COMPLETE_THRESHOLD = float(os.getenv("TURN_COMPLETE_THRESHOLD", "0.5"))
# Fallback when the turn detector is NOT available: plain fixed-timeout endpoint.
END_OF_TURN_SILENCE_SEC = float(os.getenv("END_OF_TURN_SILENCE_MS", "400")) / 1000.0

PARTIAL_WINDOW_SAMPLES = int(SAMPLE_RATE * PARTIAL_WINDOW_SEC)
MIN_AUDIO_SAMPLES = int(SAMPLE_RATE * MIN_AUDIO_SEC)
TURN_WINDOW_SAMPLES = SAMPLE_RATE * 8

runtime = SttRuntime()
turn_detector = TurnDetector()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_in_threadpool(runtime.load)
    await run_in_threadpool(turn_detector.load)
    yield


app = FastAPI(title="VoiceAI STT Streaming Service", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "model": "faster-whisper",
        "loaded": runtime.model is not None,
        "turn_detection": turn_detector.available,
    }


@app.websocket("/ws/stt")
async def stt_websocket(ws: WebSocket):
    await ws.accept()

    audio_buffer = np.array([], dtype=np.float32)
    last_partial = ""
    silence_signaled = False
    silence_at = 0.0
    has_audio = False
    finalizing = False
    turn_consulted = False   # have we asked the turn model for this silence period?
    turn_incomplete = False  # did it say "not done yet"?
    tasks: list[asyncio.Task] = []

    async def emit_partial():
        """Live caption: transcribe only the trailing window (constant cost)."""
        nonlocal last_partial

        if len(audio_buffer) < MIN_AUDIO_SAMPLES:
            return

        window = audio_buffer[-PARTIAL_WINDOW_SAMPLES:].copy()
        text = await run_in_threadpool(runtime.transcribe_buffer, window)

        if text and text != last_partial:
            last_partial = text
            await ws.send_json({"text": text, "is_final": False})

    async def finalize():
        """Fresh full-buffer decode, then emit the final transcript and reset.

        Decoding the whole buffer here (not reusing the last windowed partial)
        guarantees the final transcript contains the user's last words —
        fixing the mid-tick truncation the old tick-based path could cause.
        """
        nonlocal audio_buffer, last_partial, silence_signaled, silence_at, has_audio
        nonlocal finalizing, turn_consulted, turn_incomplete

        if finalizing:
            return
        finalizing = True
        try:
            snap_len = len(audio_buffer)
            snapshot = audio_buffer[:snap_len].copy()

            # beam_size=5 on the final pass for accuracy (it's one decode per
            # turn, so the latency cost is fine). Partials stay at beam 1.
            text = await run_in_threadpool(runtime.transcribe_buffer, snapshot, 5)
            text = (text or last_partial).strip()

            if text:
                await ws.send_json({"text": text, "is_final": True})

            # Keep any audio that streamed in while we were decoding.
            audio_buffer = audio_buffer[snap_len:]
            last_partial = ""
            silence_signaled = False
            silence_at = 0.0
            has_audio = len(audio_buffer) > 0
            turn_consulted = False
            turn_incomplete = False
        finally:
            finalizing = False

    async def partial_loop():
        while True:
            await asyncio.sleep(PARTIAL_INTERVAL)
            if (has_audio and not silence_signaled and not finalizing
                    and len(audio_buffer) >= MIN_AUDIO_SAMPLES):
                await emit_partial()

    async def finalize_loop():
        # Endpointing. With the turn detector: consult it once silence crosses
        # MIN_ENDPOINT — "complete" finalizes immediately, "not done" waits up
        # to MAX_ENDPOINT before committing anyway (so we never hang). Without
        # the detector: plain fixed-timeout (END_OF_TURN_SILENCE) fallback.
        nonlocal turn_consulted, turn_incomplete

        while True:
            await asyncio.sleep(FINALIZE_POLL_SEC)

            if (finalizing or not silence_signaled or not has_audio
                    or len(audio_buffer) < MIN_AUDIO_SAMPLES):
                continue

            held = time.monotonic() - silence_at

            if not turn_detector.available:
                if held >= END_OF_TURN_SILENCE_SEC:
                    await finalize()
                continue

            if held < MIN_ENDPOINT_SILENCE_SEC:
                continue

            if not turn_consulted:
                turn_consulted = True
                window = audio_buffer[-TURN_WINDOW_SAMPLES:].copy()
                prob = await run_in_threadpool(turn_detector.complete_probability, window)
                # User may have resumed talking during the (short) inference.
                if not silence_signaled:
                    continue
                complete = prob is None or prob >= TURN_COMPLETE_THRESHOLD
                print(
                    f"[turn] prob_complete={prob if prob is None else round(prob, 2)} "
                    f"held={int(held * 1000)}ms -> {'COMPLETE' if complete else 'WAIT'}",
                    flush=True,
                )
                if complete:
                    await finalize()
                else:
                    turn_incomplete = True
            elif turn_incomplete and held >= MAX_ENDPOINT_SILENCE_SEC:
                # Model wasn't sure we were done, but silence ran long — commit.
                await finalize()

    tasks = [
        asyncio.create_task(partial_loop()),
        asyncio.create_task(finalize_loop()),
    ]

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
                # Do NOT touch silence state here: incoming bytes may be the
                # trailing-silence tail the orchestrator forwards for the turn
                # model. Resumption is signaled explicitly via {"speech": true}.

            elif "text" in msg and msg["text"]:
                try:
                    control = json.loads(msg["text"])
                    if control.get("speech"):
                        # Explicit resume from the energy gate — cancel any
                        # pending finalize and re-arm the turn check.
                        silence_signaled = False
                        turn_consulted = False
                        turn_incomplete = False
                    elif control.get("silence") and not silence_signaled:
                        silence_signaled = True
                        silence_at = time.monotonic()
                except json.JSONDecodeError:
                    pass

    except WebSocketDisconnect:
        pass
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=STT_PORT)
