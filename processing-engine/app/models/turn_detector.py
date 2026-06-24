"""Semantic end-of-turn detection using Smart Turn v3 (audio-based, ONNX).

Smart Turn predicts whether the speaker has FINISHED their turn from the audio
of the current utterance (prosody / trailing intonation), instead of relying on
silence duration alone. This lets the agent wait through a mid-sentence pause
("my name is... Aaron") rather than barging in.

Smart Turn v3 is published as a self-contained ONNX graph (Whisper-tiny encoder
+ attention pooling + MLP head) that outputs a single probability — values >=
0.5 mean the turn is complete. We run it on CPU via onnxruntime; the only
preprocessing is a Whisper log-mel spectrogram (8s window).

Safe by design: if the model can't load or inference errors, `available` stays
False and probabilities return None, so the STT service falls back to
fixed-timeout endpointing.

Env knobs:
  TURN_DETECTION=off    disable entirely (use timeout endpointing)
  TURN_MODEL=...        HF repo id (default pipecat-ai/smart-turn-v3)
  TURN_ONNX_FILE=...    which ONNX file to load (default smart-turn-v3.2-cpu.onnx)
"""

import math
import os

import numpy as np

SAMPLE_RATE = 16000
MAX_TURN_SECONDS = 8
MAX_SAMPLES = SAMPLE_RATE * MAX_TURN_SECONDS

TURN_MODEL = os.getenv("TURN_MODEL", "pipecat-ai/smart-turn-v3")
TURN_ONNX_FILE = os.getenv("TURN_ONNX_FILE", "smart-turn-v3.2-cpu.onnx")


class TurnDetector:
    def __init__(self) -> None:
        self.session = None
        self.feature_extractor = None
        self.input_name = None
        self.available = False

    def load(self) -> None:
        if os.getenv("TURN_DETECTION", "on").lower() in ("0", "off", "false", "no"):
            print("Turn detection disabled (TURN_DETECTION=off) — timeout endpointing.", flush=True)
            return
        try:
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
            from transformers import WhisperFeatureExtractor

            print(f"Loading turn detector: {TURN_MODEL}/{TURN_ONNX_FILE} (CPU)...", flush=True)
            onnx_path = hf_hub_download(repo_id=TURN_MODEL, filename=TURN_ONNX_FILE)

            self.session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
            self.feature_extractor = WhisperFeatureExtractor(chunk_length=MAX_TURN_SECONDS)
            self.input_name = self.session.get_inputs()[0].name

            ins = [(i.name, i.shape) for i in self.session.get_inputs()]
            outs = [(o.name, o.shape) for o in self.session.get_outputs()]
            print(f"Turn detector loaded. inputs={ins} outputs={outs}", flush=True)
            self.available = True
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
            audio = np.asarray(audio_np, dtype=np.float32)[-MAX_SAMPLES:]

            feats = self.feature_extractor(
                audio,
                sampling_rate=SAMPLE_RATE,
                return_tensors="np",
                padding="max_length",
                max_length=MAX_SAMPLES,
                truncation=True,
                do_normalize=True,
            )
            input_features = np.asarray(feats["input_features"], dtype=np.float32)

            outputs = self.session.run(None, {self.input_name: input_features})
            value = float(np.ravel(outputs[0])[0])

            # v3 outputs a probability already; if a build emits a raw logit
            # (outside [0,1]), squash it so the threshold still makes sense.
            if value < 0.0 or value > 1.0:
                value = 1.0 / (1.0 + math.exp(-value))
            return value
        except Exception as exc:  # noqa: BLE001
            print(f"Turn detection error ({exc}); treating as complete.", flush=True)
            return None
