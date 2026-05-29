"""Compatibility shims for third-party libraries."""

from omegaconf.dictconfig import DictConfig

_PATCHED = False


def apply_nemo_compat() -> None:
    """Make a missing ``audio_locator_tag`` fall back to the default placeholder.

    Newer NeMo checkpoints may not define this key; without this shim, attribute
    access raises instead of returning the expected locator token. Idempotent.
    """
    global _PATCHED
    if _PATCHED:
        return

    original_getattr = DictConfig.__getattr__

    def patched_getattr(self, key):
        if key == "audio_locator_tag":
            try:
                return original_getattr(self, key)
            except Exception:
                return "<|audioplaceholder|>"
        return original_getattr(self, key)

    DictConfig.__getattr__ = patched_getattr
    _PATCHED = True
