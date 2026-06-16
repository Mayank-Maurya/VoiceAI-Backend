from .stt import SttRuntime
from .tts import TtsRuntime

stt_runtime = SttRuntime()
tts_runtime = TtsRuntime()

__all__ = ["SttRuntime", "TtsRuntime", "stt_runtime", "tts_runtime"]
