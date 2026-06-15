"""Text-to-speech runtime using Kokoro-82M."""

import asyncio
import io
from typing import Any, Generator

import numpy as np
import soundfile as sf
from kokoro import KPipeline

from app.config import TTS_LANG_CODE, TTS_SAMPLE_RATE, TTS_SPEED, TTS_VOICE


class TtsRuntime:
    def __init__(self) -> None:
        self.pipeline: Any | None = None
        self.voice = TTS_VOICE
        self.lock = asyncio.Lock()

    def load(self) -> None:
        if self.pipeline is not None:
            return

        print("Loading TTS model: Kokoro-82M...", flush=True)
        self.pipeline = KPipeline(lang_code=TTS_LANG_CODE)
        print("TTS loaded (CPU/GPU auto-mapped).")

    def generate_audio_bytes(self, text: str) -> bytes:
        if self.pipeline is None:
            raise RuntimeError("TTS model is not loaded")

        # Kokoro yields (graphemes, phonemes, audio) per chunk; collect the audio.
        audio_chunks = [
            audio for _, _, audio in self.pipeline(text, voice=self.voice, speed=TTS_SPEED)
        ]
        if not audio_chunks:
            return b""

        full_audio = np.concatenate(audio_chunks)

        # Encode to an in-memory WAV file (no disk I/O).
        wav_io = io.BytesIO()
        sf.write(wav_io, full_audio, TTS_SAMPLE_RATE, format="WAV")
        return wav_io.getvalue()
    
    def generate_audio_chunks(self, text: str) -> Generator[bytes, None, None]: 
        """Streaming method — yields length-prefixed PCM16 chunks as Kokoro generates them.

        Each yielded bytes object is: 4-byte length uint32 (payload length) + PCM16 bytes.
        The consumer reads the length prefix to know where each chunk ends.
        """
        if self.pipeline is None:
            raise RuntimeError("TTS not loaded")
        
        for _, _, audio in self.pipeline(text, voice=self.voice, speed=TTS_SPEED):
            if audio is None or len(audio) == 0:
                continue
            
            pcm16 = (audio * 32767).astype(np.int16).tobytes()

            yield struct.pack("<I", len(pcm16)) + pcm16