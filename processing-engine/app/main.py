import asyncio
import os
import re
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Thread
from typing import Any

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.concurrency import run_in_threadpool

# STT Imports
from nemo.collections.speechlm2.models import SALM

# --- MONKEY PATCH FOR NEMO MAIN BRANCH COMPATIBILITY ---
_original_salm_init = SALM.__init__

def _patched_salm_init(self, *args, **kwargs):
    # Safely extract the config whether it's positional or a keyword
    cfg = kwargs.get("cfg") if "cfg" in kwargs else (args[0] if len(args) > 0 else None)
    
    if cfg is not None:
        if isinstance(cfg, dict):
            # If it's a raw Python dictionary (which it is here)
            cfg.setdefault("audio_locator_tag", "<|audioplaceholder|>")
        else:
            # If it's already an OmegaConf object
            from omegaconf import open_dict
            with open_dict(cfg):
                if "audio_locator_tag" not in cfg:
                    cfg.audio_locator_tag = "<|audioplaceholder|>"
    elif "audio_locator_tag" not in kwargs:
        # Fallback if config is unpacked directly
        kwargs["audio_locator_tag"] = "<|audioplaceholder|>"

    _original_salm_init(self, *args, **kwargs)

SALM.__init__ = _patched_salm_init
# -------------------------------------------------------

# LLM Imports
from transformers import (
    AutoModelForCausalLM, 
    AutoTokenizer, 
    TextIteratorStreamer, 
    BitsAndBytesConfig
)

# --- CONFIGURATION ---
os.environ["MODEL_NAME"] = "nvidia/canary-qwen-2.5b"
MODEL_NAME = os.getenv("MODEL_NAME")
MAX_NEW_TOKENS = int(os.getenv("MAX_NEW_TOKENS", "128"))
LLM_MODEL_ID = "meta-llama/Llama-3.2-1B-Instruct"

HF_TOKEN = os.getenv("HF_TOKEN")

class SttRuntime:
    def __init__(self) -> None:
        self.model: Any | None = None
        self.lock = asyncio.Lock()

    def load(self) -> None:
        if self.model is not None:
            return
        
        print(f"Loading STT model: {MODEL_NAME}...", flush=True)
        self.model = SALM.from_pretrained(MODEL_NAME).bfloat16().eval()

        if torch.cuda.is_available():
            self.model = self.model.cuda()
            print("STT loaded into VRAM.")

    def transcribe_file(self, audio_path: str) -> str:
        if self.model is None:
            raise RuntimeError("STT model is not loaded")

        prompts = [[{
            "role": "user",
            "content": f"Transcribe the following: {self.model.audio_locator_tag}",
            "audio": [audio_path],
        }]]
        
        with torch.no_grad():
            answer_ids = self.model.generate(
                prompts=prompts,
                max_new_tokens=MAX_NEW_TOKENS,
            )
        return self.model.tokenizer.ids_to_text(answer_ids[0].cpu()).strip()


class LlmRuntime:
    def __init__(self) -> None:
        self.model: Any | None = None
        self.tokenizer: Any | None = None
        self.lock = asyncio.Lock()

    def load(self) -> None:
        if self.model is not None:
            return

        if not HF_TOKEN:
            print("WARNING: HF_TOKEN environment variable is not set.", flush=True)

        print(f"Loading LLM model: {LLM_MODEL_ID} in 4-bit...", flush=True)
        
        # 4-bit Quantization Config (Reduces VRAM footprint to ~1.2GB)
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

        self.tokenizer = AutoTokenizer.from_pretrained(LLM_MODEL_ID, token=HF_TOKEN)
        self.model = AutoModelForCausalLM.from_pretrained(
            LLM_MODEL_ID,
            quantization_config=bnb_config,
            device_map="cuda",
            token=HF_TOKEN
        )
        print("LLM loaded into VRAM.")

    def generate_sentences(self, user_text: str):
        if self.model is None or self.tokenizer is None:
            raise RuntimeError("LLM model is not loaded")

        messages = [
            {"role": "system", "content": "You are a helpful, conversational voice assistant. Keep answers brief, natural, and spoken-word friendly. Do not use markdown, emojis, or lists."},
            {"role": "user", "content": user_text}
        ]
        
        inputs = self.tokenizer.apply_chat_template(
            messages, 
            add_generation_prompt=True, 
            return_dict=True, 
            return_tensors="pt"
        ).to("cuda")

        streamer = TextIteratorStreamer(self.tokenizer, skip_prompt=True, skip_special_tokens=True)
        
        generation_kwargs = dict(
            input_ids=inputs["input_ids"],
            attention_mask=inputs["attention_mask"],
            streamer=streamer,
            max_new_tokens=256,
            temperature=0.6,
            do_sample=True,
        )

        # --- BULLETPROOF THREAD WRAPPER TO PREVENT HANGING ---
        def _thread_runner():
            try:
                self.model.generate(**generation_kwargs)
            except Exception as e:
                print(f"\n❌ LLM Generation Crashed: {e}\n", flush=True)
            finally:
                streamer.text_queue.put(streamer.stop_signal)

        thread = Thread(target=_thread_runner, daemon=True)
        thread.start()

        sentence_buffer = ""
        sentence_boundary = re.compile(r'(?<=[.?!])\s')

        for new_text in streamer:
            sentence_buffer += new_text
            
            if sentence_boundary.search(sentence_buffer):
                parts = sentence_boundary.split(sentence_buffer, 1)
                clean_sentence = parts[0].strip()
                sentence_buffer = parts[1] if len(parts) > 1 else ""
                
                if clean_sentence:
                    yield clean_sentence

        if sentence_buffer.strip():
            yield sentence_buffer.strip()


# Instantiate the Singletons
stt_runtime = SttRuntime()
llm_runtime = LlmRuntime()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load both models into the GPU sequentially during boot
    await run_in_threadpool(stt_runtime.load)
    await run_in_threadpool(llm_runtime.load)
    yield

app = FastAPI(title="VoiceAI Mono-Brain", lifespan=lifespan)

@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": MODEL_NAME,
        "cuda": torch.cuda.is_available(),
        "loaded": stt_runtime.model is not None,
    }

@app.post("/voice-chat")
async def voice_chat(request: Request):
    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio body")

    # STEP 1: Transcribe the Audio
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = Path(tmp.name)

        async with stt_runtime.lock:
            user_text = await run_in_threadpool(stt_runtime.transcribe_file, str(tmp_path))
            
        print(f"\n[USER] {user_text}")

    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)

    # STEP 2 & 3: Generate LLM output and Stream (Currently streaming Text to test the logic)
    async def audio_stream_generator():
        # Lock the LLM so it doesn't try to answer two people at once
        async with llm_runtime.lock:
            for sentence in llm_runtime.generate_sentences(user_text):
                print(f"[AI THINKING] -> {sentence}")
                
                # TODO: Pass `sentence` to Kokoro TTS here!
                
                # For now, we yield the text back to Node.js just to prove the stream works
                yield f"{sentence}\n".encode("utf-8")

    return StreamingResponse(audio_stream_generator(), media_type="text/plain")