"""Pluggable TTS backends — local Kokoro or a cloud API — behind one interface.

Every provider yields length-prefixed PCM16 @ 24 kHz chunks:
    [4-byte LE uint32 length][PCM16 bytes]
so the orchestrator and browser are byte-identical regardless of backend.

Selected at startup via env (see tts-service.py):
    TTS_PROVIDER=kokoro       (default, local, ~free)
    TTS_PROVIDER=elevenlabs   + ELEVENLABS_API_KEY (cloud, most natural)
"""

import json
import struct
from typing import AsyncIterator

from fastapi.concurrency import run_in_threadpool


def _frame(pcm: bytes) -> bytes:
    return struct.pack("<I", len(pcm)) + pcm


class KokoroProvider:
    """Local Kokoro-82M. Collects chunks in a worker thread, then streams them —
    Kokoro is blocking GPU work, and collecting first avoids dropping the
    HTTP connection mid-stream."""

    name = "kokoro"

    def __init__(self, runtime) -> None:
        self.runtime = runtime

    async def framed_stream(self, text: str, tone: str | None = None) -> AsyncIterator[bytes]:
        chunks = await run_in_threadpool(
            lambda: list(self.runtime.generate_audio_chunks(text))
        )
        for chunk in chunks:
            yield chunk  # already length-prefixed by the runtime


class ElevenLabsProvider:
    """Cloud TTS via ElevenLabs streaming, requested as raw PCM16 @ 24 kHz."""

    name = "elevenlabs"

    def __init__(self, api_key: str, voice_id: str, model_id: str) -> None:
        self.api_key = api_key
        self.voice_id = voice_id
        self.model_id = model_id

    async def framed_stream(self, text: str, tone: str | None = None) -> AsyncIterator[bytes]:
        import httpx

        url = (
            f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream"
            "?output_format=pcm_24000"
        )
        headers = {"xi-api-key": self.api_key, "Content-Type": "application/json"}
        body = {"text": text, "model_id": self.model_id}

        buf = b""
        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                if resp.status_code != 200:
                    detail = (await resp.aread())[:300].decode("utf-8", "replace")
                    raise RuntimeError(f"ElevenLabs {resp.status_code}: {detail}")

                async for chunk in resp.aiter_bytes():
                    buf += chunk
                    # Emit whole 16-bit samples only; hold any trailing odd byte
                    # so the browser's Int16Array conversion never misaligns.
                    n = len(buf) - (len(buf) % 2)
                    if n:
                        yield _frame(buf[:n])
                        buf = buf[n:]
        if buf:
            yield _frame(buf)


class RumikProvider:
    """Cloud TTS via rumik.ai Silk. Two-step: POST to mint a one-shot WebSocket
    session, then stream raw PCM16 @ 24 kHz over the socket until the terminal
    control frame. Output format matches our pipeline exactly (no transcoding)."""

    name = "rumik"
    BASE = "https://silk-api.rumik.ai"

    def __init__(
        self, api_key: str, model: str, description: str, speaker: str,
        use_emotion_tags: bool = True,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.description = description
        self.speaker = speaker
        self.use_emotion_tags = use_emotion_tags

    async def framed_stream(self, text: str, tone: str | None = None) -> AsyncIterator[bytes]:
        import httpx
        import websockets

        # Emotion → spoken tone: rumik reads a leading [tag] in the text and
        # voices it with that emotion (the tag itself is not spoken).
        if tone and self.use_emotion_tags:
            text = f"[{tone}] {text}"

        # 1. Mint a one-shot WebSocket session -> { ws_url, token }.
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self.BASE}/v1/tts/ws-connect",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={"model": self.model, "text": text},
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Rumik ws-connect {resp.status_code}: {resp.text[:300]}")
            session = resp.json()

        # 2. Synthesis frame (speaker for mulberry; description is the voice design).
        frame = {"text": text}
        if self.description:
            frame["description"] = self.description
        if self.speaker:
            frame["speaker"] = self.speaker

        # 3. Connect, send, stream PCM until done / cancelled / error.
        buf = b""
        ws_url = f'{session["ws_url"]}?token={session["token"]}'
        async with websockets.connect(ws_url) as ws:
            await ws.send(json.dumps(frame))
            async for msg in ws:
                if isinstance(msg, (bytes, bytearray)):
                    buf += bytes(msg)
                    n = len(buf) - (len(buf) % 2)
                    if n:
                        yield _frame(buf[:n])
                        buf = buf[n:]
                else:
                    ctrl = json.loads(msg)
                    if ctrl.get("type") in ("done", "cancelled", "timeout") or ctrl.get("error"):
                        break
        if buf:
            yield _frame(buf)
