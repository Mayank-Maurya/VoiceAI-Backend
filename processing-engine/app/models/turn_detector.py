"""Semantic end-of-turn detection using Smart Turn v3 (audio-based).

Smart Turn predicts whether the speaker has FINISHED their turn from the audio
of the current utterance (prosody / trailing intonation), instead of relying on
silence duration alone. This lets the agent wait through a mid-sentence pause
("my name is... Aaron") rather than barging in.

The model is a Whisper-tiny encoder + attention pooling + MLP head that outputs a
single probability (>= 0.5 => the turn is complete). The class below is vendored
from pipecat-ai/smart-turn (train.py) so the checkpoint's real head loads
correctly — loading it via the generic HF audio-classification class silently
re-initialises the head with random weights (random predictions).

Safe by design: if the model can't load or inference errors, `available` stays
False and probabilities return None, so the STT service falls back to
fixed-timeout endpointing. Runs on CPU (tiny model) to avoid GPU contention.

Env knobs:
  TURN_DETECTION=off    disable entirely (use timeout endpointing)
  TURN_MODEL=...        HF model id (default pipecat-ai/smart-turn-v3)
"""

import os

import numpy as np

SAMPLE_RATE = 16000
MAX_TURN_SECONDS = 8
MAX_SAMPLES = SAMPLE_RATE * MAX_TURN_SECONDS

TURN_MODEL = os.getenv("TURN_MODEL", "pipecat-ai/smart-turn-v3")


class TurnDetector:
    def __init__(self) -> None:
        self.model = None
        self.feature_extractor = None
        self.available = False
        self._torch = None

    def load(self) -> None:
        if os.getenv("TURN_DETECTION", "on").lower() in ("0", "off", "false", "no"):
            print("Turn detection disabled (TURN_DETECTION=off) — timeout endpointing.", flush=True)
            return
        try:
            import torch
            from torch import nn
            from transformers import (
                WhisperConfig,
                WhisperFeatureExtractor,
                WhisperPreTrainedModel,
            )
            from transformers.models.whisper.modeling_whisper import WhisperEncoder

            # Vendored verbatim from pipecat-ai/smart-turn so the checkpoint's
            # custom head (attention pooling + MLP) loads with its real weights.
            class SmartTurnV3Model(WhisperPreTrainedModel):
                def __init__(self, config: WhisperConfig):
                    super().__init__(config)
                    config.max_source_positions = 400
                    self.encoder = WhisperEncoder(config)
                    hidden_size = config.d_model

                    self.pool_attention = nn.Sequential(
                        nn.Linear(hidden_size, 256),
                        nn.Tanh(),
                        nn.Linear(256, 1),
                    )
                    self.classifier = nn.Sequential(
                        nn.Linear(hidden_size, 256),
                        nn.LayerNorm(256),
                        nn.GELU(),
                        nn.Dropout(0.1),
                        nn.Linear(256, 64),
                        nn.GELU(),
                        nn.Linear(64, 1),
                    )

                def forward(self, input_features):
                    hidden_states = self.encoder(
                        input_features=input_features
                    ).last_hidden_state
                    attention_weights = torch.softmax(
                        self.pool_attention(hidden_states), dim=1
                    )
                    pooled = torch.sum(hidden_states * attention_weights, dim=1)
                    logits = self.classifier(pooled)
                    return torch.sigmoid(logits)

            print(f"Loading turn detector: {TURN_MODEL} (CPU)...", flush=True)
            self.feature_extractor = WhisperFeatureExtractor(chunk_length=MAX_TURN_SECONDS)
            self.model = SmartTurnV3Model.from_pretrained(TURN_MODEL).eval()
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
            audio = np.asarray(audio_np, dtype=np.float32)[-MAX_SAMPLES:]

            inputs = self.feature_extractor(
                audio,
                sampling_rate=SAMPLE_RATE,
                return_tensors="pt",
                padding="max_length",
                max_length=MAX_SAMPLES,
                truncation=True,
                do_normalize=True,
            )
            with torch.no_grad():
                probs = self.model(input_features=inputs.input_features)
            return float(probs.view(-1)[0].item())
        except Exception as exc:  # noqa: BLE001
            print(f"Turn detection error ({exc}); treating as complete.", flush=True)
            return None
