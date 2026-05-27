import asyncio
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse
from fastapi.concurrency import run_in_threadpool

# STT Imports
from nemo.collections.speechlm2.models import SALM

# --- MONKEY PATCH FOR NEMO MAIN BRANCH COMPATIBILITY ---
from omegaconf.dictconfig import DictConfig
_orig_getattr = DictConfig.__getattr__

def _patched_getattr(self, key):
    if key == "audio_locator_tag":
        try:
            return _orig_getattr(self, key)
        except Exception:
            return "<|audioplaceholder|>"
    return _orig_getattr(self, key)

DictConfig.__getattr__ = _patched_getattr
# -------------------------------------------------------

# LLM Imports
from transformers import (
    AutoModelForCausalLM, 
    AutoTokenizer, 
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

    def generate_response(self, user_text: str) -> str:
        if self.model is None or self.tokenizer is None:
            raise RuntimeError("LLM model is not loaded")

        messages = [
            {"role": "system", "content": "You are a helpful, conversational voice assistant. Keep answers brief, natural, and spoken-word friendly. Do not use markdown, emojis, or lists."},
            {"role": "user", "content": user_text}
        ]
        
        # Format input synchronously
        inputs = self.tokenizer.apply_chat_template(
            messages, 
            add_generation_prompt=True, 
            return_dict=True, 
            return_tensors="pt"
        ).to("cuda")

        # Generate output synchronously (This will block until the whole answer is done)
        with torch.no_grad():
            outputs = self.model.generate(
                input_ids=inputs["input_ids"],
                attention_mask=inputs["attention_mask"],
                max_new_tokens=256,
                temperature=0.6,
                do_sample=True,
                pad_token_id=self.tokenizer.eos_token_id
            )

        # Decode the output, stripping away the prompt we sent it
        input_length = inputs["input_ids"].shape[1]
        generated_tokens = outputs[0][input_length:]
        
        response_text = self.tokenizer.decode(generated_tokens, skip_special_tokens=True).strip()
        return response_text


# Instantiate the Singletons
stt_runtime = SttRuntime()
llm_runtime = LlmRuntime()

@asynccontextmanager
async def lifespan(app: FastAPI):
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

    # STEP 2: Generate LLM output synchronously
    async with llm_runtime.lock:
        ai_response = await run_in_threadpool(llm_runtime.generate_response, user_text)
        
    print(f"[AI THINKING] -> {ai_response}\n")

    # TODO: Pass ai_response to Kokoro TTS here!
    
    # Return standard plain text response (No streaming)
    return PlainTextResponse(ai_response)