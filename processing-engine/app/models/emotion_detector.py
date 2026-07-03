"""Speech emotion recognition (SER) — a soft signal for HOW the user spoke.

Runs a wav2vec2 audio-classification model on CPU alongside the STT and returns
the top emotion for an utterance. Fed to the LLM so replies can be empathetic.

NOTE: SER models are trained mostly on *acted* emotion, so on real conversational
speech this is a noisy hint, not ground truth — treat it as a nudge, not fact.

Safe by design: if the model can't load or inference errors, detect() returns
None and the pipeline behaves exactly as before.

Env:
  EMOTION_DETECTION=off    disable entirely
  EMOTION_MODEL=...        HF model id (default superb/wav2vec2-base-superb-er;
                           for 8 emotions try
                           ehcalabres/wav2vec2-lg-xlsr-en-speech-emotion-recognition)
"""

import os

import numpy as np

SAMPLE_RATE = 16000
MAX_SECONDS = 10
MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS
MIN_SAMPLES = SAMPLE_RATE // 2  # <0.5s is too short to judge tone

EMOTION_MODEL = os.getenv("EMOTION_MODEL", "superb/wav2vec2-base-superb-er")

# Normalize common SER label abbreviations to plain words the LLM understands.
LABEL_MAP = {
    "neu": "neutral", "hap": "happy", "ang": "angry", "sad": "sad",
    "exc": "excited", "fru": "frustrated", "fea": "fearful", "fear": "fearful",
    "dis": "disgust", "sur": "surprised", "cal": "calm",
}


class EmotionDetector:
    def __init__(self) -> None:
        self.model = None
        self.feature_extractor = None
        self.available = False
        self._torch = None

    def load(self) -> None:
        if os.getenv("EMOTION_DETECTION", "on").lower() in ("0", "off", "false", "no"):
            print("Emotion detection disabled (EMOTION_DETECTION=off).", flush=True)
            return
        try:
            import torch
            from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

            print(f"Loading emotion detector: {EMOTION_MODEL} (CPU)...", flush=True)
            self.feature_extractor = AutoFeatureExtractor.from_pretrained(EMOTION_MODEL)
            self.model = AutoModelForAudioClassification.from_pretrained(EMOTION_MODEL).eval()
            self._torch = torch
            self.available = True
            print("Emotion detector loaded.", flush=True)
        except Exception as exc:  # noqa: BLE001 - never let this break startup
            print(f"Emotion detector unavailable ({exc}); tone will be omitted.", flush=True)
            self.available = False

    def detect(self, audio_np: np.ndarray):
        """Return (label, score) for the top emotion, or None if unavailable /
        too short / errored."""
        if not self.available:
            return None
        try:
            torch = self._torch
            audio = np.asarray(audio_np, dtype=np.float32)[-MAX_SAMPLES:]
            if len(audio) < MIN_SAMPLES:
                return None

            inputs = self.feature_extractor(
                audio, sampling_rate=SAMPLE_RATE, return_tensors="pt"
            )
            with torch.no_grad():
                logits = self.model(**inputs).logits
                probs = torch.softmax(logits, dim=-1)[0]

            idx = int(probs.argmax().item())
            raw = str(self.model.config.id2label[idx]).lower()
            return LABEL_MAP.get(raw, raw), float(probs[idx].item())
        except Exception as exc:  # noqa: BLE001
            print(f"Emotion detection error ({exc}); omitting tone.", flush=True)
            return None
