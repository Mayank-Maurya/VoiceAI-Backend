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
        device = os.getenv("STT_DEVICE", "cuda")
        compute_type = os.getenv("STT_COMPUTE_TYPE", "int8")

        print(
            f"Loading STT model: faster-whisper {STT_MODEL_NAME} "
            f"({compute_type}) on {device}, num_workers={num_workers}...",
            flush=True,
        )
        self.model = WhisperModel(
            STT_MODEL_NAME,
            device=device,
            compute_type=compute_type,
            num_workers=num_workers,
        )
        print(f"STT loaded ({device}).", flush=True)

    def transcribe_buffer(self, audio_np: np.ndarray, beam_size: int = 1) -> str:
        """Transcribe a numpy float32 audio array (16kHz mono).

        vad_filter uses faster-whisper's built-in Silero VAD to strip
        non-speech BEFORE decoding. This is the key defense against Whisper
        hallucinating phrases like "Thanks for watching!" on silence/noise:
        if the audio is non-speech, VAD removes it and we get an empty result
        instead of an invented sentence.

        condition_on_previous_text=False stops the decoder from inventing
        continuations based on prior context (each buffer is independent).
        beam_size=1 for fast live partials; pass 5 on the final pass for accuracy.
        """
        if self.model is None:
            raise RuntimeError("STT model is not loaded")

        segments, _ = self.model.transcribe(
            audio_np,
            beam_size=beam_size,
            language="en",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=300),
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
        )

        return " ".join(seg.text.strip() for seg in segments).strip()
