"""Semantic end-of-turn detection using Smart Turn v2 (audio-based).

Predicts whether the speaker has FINISHED their turn from the audio of the
current utterance (prosody / trailing intonation), instead of relying on
silence duration alone. This is what lets the agent wait through a mid-sentence
pause ("my name is... Aaron") rather than barging in.

Safe by design: if the model can't load or inference errors, `available` stays
False and probabilities return None, so the STT service falls back to
fixed-timeout endpointing. Nothing in the hot path can break because of this.

Runs on CPU by default — Smart Turn v2 is tiny (tens of ms) and keeping it off
the GPU avoids contention with STT/TTS/vLLM.

Env knobs:
  TURN_DETECTION=off            disable entirely (use timeout endpointing)
  TURN_MODEL=...                HF model id (default pipecat-ai/smart-turn-v2)
  TURN_COMPLETE_THRESHOLD=0.5   prob >= this => "complete"
  TURN_COMPLETE_LABEL_INDEX=1   which output class means "complete" — flip to 0
                                if the sanity-check logs look inverted
"""

import os

import numpy as np

SAMPLE_RATE = 16000
MAX_TURN_SECONDS = 8

TURN_MODEL = os.getenv("TURN_MODEL", "pipecat-ai/smart-turn-v2")
COMPLETE_LABEL_INDEX = int(os.getenv("TURN_COMPLETE_LABEL_INDEX", "1"))


class TurnDetector:
    def __init__(self) -> None:
        self.model = None
        self.processor = None
        self.available = False
        self._torch = None

    def load(self) -> None:
        if os.getenv("TURN_DETECTION", "on").lower() in ("0", "off", "false", "no"):
            print("Turn detection disabled (TURN_DETECTION=off) — timeout endpointing.", flush=True)
            return
        try:
            import torch
            from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

            print(f"Loading turn detector: {TURN_MODEL} (CPU)...", flush=True)
            self.processor = AutoFeatureExtractor.from_pretrained(TURN_MODEL)
            self.model = AutoModelForAudioClassification.from_pretrained(TURN_MODEL)
            self.model.eval()
            self._torch = torch
            self.available = True
            print("Turn detector loaded.", flush=True)
        except Exception as exc:  # noqa: BLE001 - never let this break startup
            print(
                f"Turn detector unavailable ({exc}); falling back to timeout endpointing.",
                flush=True,
            )
            self.available = False

    def complete_probability(self, audio_np: np.ndarray) -> float | None:
        """P(turn complete) in [0, 1], or None if unavailable / errored.

        None tells the caller to fall back (treat as complete) rather than hang.
        """
        if not self.available:
            return None
        try:
            torch = self._torch
            audio = np.asarray(audio_np, dtype=np.float32)
            audio = audio[-SAMPLE_RATE * MAX_TURN_SECONDS:]

            inputs = self.processor(
                audio,
                sampling_rate=SAMPLE_RATE,
                return_tensors="pt",
                padding="max_length",
                max_length=SAMPLE_RATE * MAX_TURN_SECONDS,
                truncation=True,
            )
            with torch.no_grad():
                logits = self.model(**inputs).logits
                probs = torch.softmax(logits, dim=-1)[0]
            return float(probs[COMPLETE_LABEL_INDEX].item())
        except Exception as exc:  # noqa: BLE001
            print(f"Turn detection error ({exc}); treating as complete.", flush=True)
            return None
