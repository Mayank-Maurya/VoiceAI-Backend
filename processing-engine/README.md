# Processing Engine

The GPU inference service. A single FastAPI app that runs a full voice turn:

```
WAV in  ->  STT (Canary)  ->  LLM (Llama 3.2)  ->  TTS (Kokoro)  ->  WAV out
```

Runs on a dedicated compute node with an NVIDIA GPU (e.g. an RTX 3060).

> Bare-metal only for now. Docker/Compose will be reintroduced in a later
> session alongside Grafana + Prometheus.

## Project structure

```
app/
  main.py            # FastAPI app: loads models on startup, mounts routes
  config.py          # All tunables, sourced from environment variables
  compat.py          # NeMo compatibility shim
  pipeline.py        # Orchestrates one voice turn (STT -> LLM -> TTS)
  api/
    routes.py        # /health and /voice-chat endpoints
  models/
    __init__.py      # Shared singletons: stt_runtime, llm_runtime, tts_runtime
    stt.py           # SttRuntime  (NVIDIA Canary / SALM)
    llm.py           # LlmRuntime  (Llama 3.2, 4-bit)
    tts.py           # TtsRuntime  (Kokoro-82M)
```

## Setup (Linux)

```bash
# 1. System audio dependencies
sudo apt-get update && sudo apt-get install -y git ffmpeg libsndfile1

# 2. Isolated Python environment
python3 -m venv venv
source venv/bin/activate

# 3. PyTorch (CUDA 12.4)
pip install --upgrade pip setuptools wheel
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124

# 4. Remaining dependencies (FastAPI, NeMo, Kokoro, etc.)
pip install -r requirements.txt
```

## Run

```bash
export HF_HOME=$(pwd)/models/huggingface
export TRANSFORMERS_CACHE=$(pwd)/models/huggingface
export NEMO_CACHE_DIR=$(pwd)/models/nemo
export HF_TOKEN=<your-hf-token>      # required for the Llama model

uvicorn app.main:app --host 0.0.0.0 --port 7001
```

## Test

```bash
# Returns audio/wav (the synthesized spoken reply)
curl -X POST http://<PC_IP>:7001/voice-chat \
     -H "Content-Type: audio/wav" \
     --data-binary @path/to/test_audio.wav \
     --output reply.wav
```

## Environment variables

| Variable          | Default                     | Purpose                                    |
| ----------------- | --------------------------- | ------------------------------------------ |
| `MODEL_NAME`        | `nvidia/canary-qwen-2.5b`   | STT model. Swap for a lighter one on low VRAM. |
| `MAX_NEW_TOKENS`    | `128`                       | STT decode cap.                            |
| `LLM_MODEL_ID`      | `meta-llama/Llama-3.2-1B-Instruct` | Conversational LLM.                 |
| `LLM_MAX_NEW_TOKENS`| `256`                       | LLM reply length cap.                      |
| `LLM_DETERMINISTIC` | `false`                     | `true` = greedy decoding: identical reply per input (stable benchmarks). |
| `HF_TOKEN`          | _(unset)_                   | HuggingFace token for gated model weights. |
| `HF_HOME`           | _(unset)_                   | Cache directory for model weights.         |
| `PORT`              | `7001`                      | Server port.                               |
