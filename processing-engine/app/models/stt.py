"""Speech-to-text runtime using faster-whisper (CTranslate2)."""

import os

import numpy as np
from faster_whisper import WhisperModel

from app.config import STT_MODEL_NAME


class SttRuntime:
    def __init__(self) -> None:
        self.model: WhisperModel | None = None

    def load(self) -> None:
        if self.model is not None:
            return

        # num_workers > 1 lets multiple transcribe() calls run concurrently,
        # each on its own CUDA stream. Workers share the weights (cheap on
        # VRAM) — only per-request activation buffers are duplicated.
        num_workers = int(os.getenv("STT_NUM_WORKERS", "4"))

        print(
            f"Loading STT model: faster-whisper {STT_MODEL_NAME} (int8) on cuda, "
            f"num_workers={num_workers}...",
            flush=True,
        )
        self.model = WhisperModel(
            STT_MODEL_NAME,
            device="cuda",
            compute_type="int8",
            num_workers=num_workers,
        )
        print("STT loaded into VRAM.", flush=True)

    def transcribe_buffer(self, audio_np: np.ndarray) -> str:
        """Transcribe a numpy float32 audio array (16kHz mono)."""
        if self.model is None:
            raise RuntimeError("STT model is not loaded")

        segments, _ = self.model.transcribe(
            audio_np,
            beam_size=1,
            language="en",
            vad_filter=False,
        )

        return " ".join(seg.text.strip() for seg in segments).strip()

    def transcribe_file(self, audio_path: str) -> str:
        """Transcribe from a file path (kept for backward compat with STT worker)."""
        if self.model is None:
            raise RuntimeError("STT model is not loaded")

        segments, _ = self.model.transcribe(
            audio_path,
            beam_size=1,
            language="en",
            vad_filter=False,
        )

        return " ".join(seg.text.strip() for seg in segments).strip()
