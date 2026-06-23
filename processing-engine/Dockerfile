# GPU image for the VoiceAI processing services (STT + TTS).
# Built once, run as two services — see docker-compose.yml.
#
# Base ships torch + CUDA 12.1 + cuDNN 9, which Kokoro (TTS) and Smart Turn
# (transformers) need, and which recent ctranslate2 (faster-whisper, STT) also
# targets. If faster-whisper can't find cuDNN at runtime, set STT_DEVICE=cpu in
# compose as a fallback — the model is small enough to run on CPU.
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps: espeak-ng (Kokoro G2P), libsndfile1 (soundfile), ffmpeg (audio I/O).
RUN apt-get update && apt-get install -y --no-install-recommends \
        espeak-ng \
        libsndfile1 \
        ffmpeg \
        git \
    && rm -rf /var/lib/apt/lists/*

# torch is already in the base image, so the pip deps below won't reinstall it.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Default command; docker-compose overrides this per service
# (stt_service.py on :7003, tts-service.py on :7002).
CMD ["python", "stt_service.py"]
