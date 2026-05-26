import asyncio
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from nemo.collections.speechlm2.models import SALM


MODEL_NAME = os.getenv("MODEL_NAME", "nvidia/canary-qwen-2.5b")
MAX_NEW_TOKENS = int(os.getenv("MAX_NEW_TOKENS", "128"))


class SttRuntime:
    def __init__(self) -> None:
        self.model: Any | None = None
        self.lock = asyncio.Lock()

    def load(self) -> None:
        if self.model is not None:
            return

        started_at = time.perf_counter()
        print(f"loading STT model: {MODEL_NAME}", flush=True)
        self.model = SALM.from_pretrained(MODEL_NAME)
        self.model.eval()

        if torch.cuda.is_available():
            self.model = self.model.cuda()

        elapsed = time.perf_counter() - started_at
        print(f"loaded STT model in {elapsed:.2f}s", flush=True)

    def transcribe_file(self, audio_path: str) -> str:
        if self.model is None:
            raise RuntimeError("STT model is not loaded")

        answer_ids = self.model.generate(
            prompts=[
                [
                    {
                        "role": "user",
                        "content": (
                            f"Transcribe the following: "
                            f"{self.model.audio_locator_tag}"
                        ),
                        "audio": [audio_path],
                    }
                ]
            ],
            max_new_tokens=MAX_NEW_TOKENS,
        )

        return self.model.tokenizer.ids_to_text(answer_ids[0].cpu()).strip()


runtime = SttRuntime()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_in_threadpool(runtime.load)
    yield


app = FastAPI(title="VoiceAI STT Service", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": MODEL_NAME,
        "cuda": torch.cuda.is_available(),
        "loaded": runtime.model is not None,
    }


@app.post("/transcribe")
async def transcribe(request: Request) -> dict[str, Any]:
    content_type = request.headers.get("content-type", "")
    if "audio/wav" not in content_type and "audio/x-wav" not in content_type:
        raise HTTPException(
            status_code=415,
            detail="POST a 16kHz mono WAV body with content-type audio/wav",
        )

    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio body")

    tmp_path: Path | None = None
    started_at = time.perf_counter()

    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = Path(tmp.name)

        async with runtime.lock:
            text = await run_in_threadpool(runtime.transcribe_file, str(tmp_path))

        elapsed = time.perf_counter() - started_at
        return {
            "text": text,
            "model": MODEL_NAME,
            "elapsed_seconds": elapsed,
        }
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
