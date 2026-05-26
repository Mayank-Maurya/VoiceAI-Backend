# STT Service

Dockerized FastAPI service for local Canary-Qwen-2.5B transcription.

## Run

```bash
docker build -t voiceai-stt ./stt-service
docker run --rm --gpus all -p 7001:7001 -v voiceai-hf-cache:/models voiceai-stt
```

Health check:

```bash
curl http://localhost:7001/health
```

Transcribe a WAV file:

```bash
curl -X POST http://localhost:7001/transcribe \
  -H "content-type: audio/wav" \
  --data-binary @speech.wav
```

The input audio must be 16kHz mono WAV.
