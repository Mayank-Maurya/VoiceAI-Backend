"""Model runtimes and their shared singleton instances.

Each runtime is instantiated once here and imported elsewhere so the whole
process shares a single set of loaded weights.
"""

from .llm import LlmRuntime
from .stt import SttRuntime
from .tts import TtsRuntime

stt_runtime = SttRuntime()
llm_runtime = LlmRuntime()
tts_runtime = TtsRuntime()

__all__ = [
    "SttRuntime",
    "LlmRuntime",
    "TtsRuntime",
    "stt_runtime",
    "llm_runtime",
    "tts_runtime",
]
