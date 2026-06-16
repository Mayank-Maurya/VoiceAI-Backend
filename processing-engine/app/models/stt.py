"""Speech-to-text runtime using faster-whisper (CTranslate2)."""

import numpy as np
from faster_whisper import WhisperModel

from app.config import STT_MODEL_NAME


class SttRuntime:
    def __init__(self) -> None:
        self.model: WhisperModel | None = None

    def load(self) -> None:
        if self.model is not None:
            return

        print(f"Loading STT model: faster-whisper {STT_MODEL_NAME} (int8)...", flush=True)
        self.model = WhisperModel(
            STT_MODEL_NAME,
            device="cuda",
            compute_type="int8",
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
