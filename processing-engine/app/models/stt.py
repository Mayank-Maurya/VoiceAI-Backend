"""Speech-to-text runtime using NVIDIA Canary (SALM)."""

import asyncio
from typing import Any

import torch

from app.compat import apply_nemo_compat
from app.config import STT_MAX_NEW_TOKENS, STT_MODEL_NAME

# Patch NeMo before importing/using SALM so config access stays safe.
apply_nemo_compat()

from nemo.collections.speechlm2.models import SALM  # noqa: E402

class SttRuntime:
    def __init__(self) -> None:
        self.model: Any | None = None
        self.lock = asyncio.Lock()

    def load(self) -> None:
        if self.model is not None:
            return

        print(f"Loading STT model: {STT_MODEL_NAME}...", flush=True)
        self.model = SALM.from_pretrained(STT_MODEL_NAME).bfloat16().eval()

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
            answer_ids = self.model.generate(prompts=prompts, max_new_tokens=STT_MAX_NEW_TOKENS)

        return self.model.tokenizer.ids_to_text(answer_ids[0].cpu()).strip()
