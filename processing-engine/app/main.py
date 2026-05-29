"""FastAPI application entrypoint: loads models and mounts HTTP routes."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool

from app.api.routes import router
from app.models import llm_runtime, stt_runtime, tts_runtime


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load every model into memory once, before the server accepts traffic.
    await run_in_threadpool(stt_runtime.load)
    await run_in_threadpool(llm_runtime.load)
    await run_in_threadpool(tts_runtime.load)
    yield


app = FastAPI(title="VoiceAI Mono-Brain", lifespan=lifespan)
app.include_router(router)
