"""Conversational LLM runtime using a 4-bit quantized Llama 3.2."""

import asyncio
from typing import Any

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

from app.config import (
    HF_TOKEN,
    LLM_DETERMINISTIC,
    LLM_MAX_NEW_TOKENS,
    LLM_MODEL_ID,
    LLM_SYSTEM_PROMPT,
    LLM_TEMPERATURE,
)


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
            token=HF_TOKEN,
        )
        print("LLM loaded into VRAM.")

    def generate_response(self, user_text: str) -> str:
        if self.model is None or self.tokenizer is None:
            raise RuntimeError("LLM model is not loaded")

        messages = [
            {"role": "system", "content": LLM_SYSTEM_PROMPT},
            {"role": "user", "content": user_text},
        ]

        inputs = self.tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to("cuda")

        gen_kwargs = {
            "input_ids": inputs["input_ids"],
            "attention_mask": inputs["attention_mask"],
            "max_new_tokens": LLM_MAX_NEW_TOKENS,
            "pad_token_id": self.tokenizer.eos_token_id,
        }
        if LLM_DETERMINISTIC:
            gen_kwargs["do_sample"] = False  # greedy: reproducible output per input
        else:
            gen_kwargs["do_sample"] = True
            gen_kwargs["temperature"] = LLM_TEMPERATURE

        with torch.no_grad():
            outputs = self.model.generate(**gen_kwargs)

        # Strip the prompt tokens so we only decode the newly generated reply.
        input_length = inputs["input_ids"].shape[1]
        generated_tokens = outputs[0][input_length:]
        return self.tokenizer.decode(generated_tokens, skip_special_tokens=True).strip()
