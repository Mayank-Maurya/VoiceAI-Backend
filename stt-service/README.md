This service runs on your dedicated Compute Node (e.g., Linux PC with RTX 3060). You can run this via Docker (recommended for portability) or Bare Metal (recommended for maximum RAM availability).

# Option A: Docker Deployment
Prerequisites: Linux OS, NVIDIA GPU, and the nvidia-container-toolkit installed.

Bash
## Navigate to the inference node directory
cd canary-inference-node

## Build the image (Downloads PyTorch base and compiles NeMo)
docker build -t voiceai-stt:local .

## Run the container (Maps port 7001 and passes through the GPU)
```
docker run --name canary-worker --gpus all -p 7001:7001 voiceai-stt:local
```
(Note: If using docker-compose, ensure the deploy.resources.reservations.devices block is set for NVIDIA drivers).

# Option B: Bare-Metal Deployment (Linux)
Use this method to bypass Docker RAM limits and avoid Code 137 OOM errors during weight decompression.

Bash
## 1. Install system audio dependencies
```
sudo apt-get update && sudo apt-get install -y git ffmpeg libsndfile1
```

## 2. Setup isolated Python environment
```
python3 -m venv venv
source venv/bin/activate
```
## 3. Install PyTorch (CUDA 12.4 optimized)
pip install --upgrade pip setuptools wheel
pip install torch torchvision torchaudio --index-url [https://download.pytorch.org/whl/cu124](https://download.pytorch.org/whl/cu124)

## 4. Install FastAPI and NeMo ASR Toolkit
``` 
pip install -r requirements.txt 
```

## 5. Start the Server
```
export PYTHONDONTWRITEBYTECODE=1 
export PYTHONUNBUFFERED=1 
export HF_HOME=$(pwd)/models/huggingface 
export TRANSFORMERS_CACHE=$(pwd)/models/huggingface 
export NEMO_CACHE_DIR=$(pwd)/models/nemo 
export MODEL_NAME=nvidia/canary-qwen-2.5b

uvicorn app.main:app --host 0.0.0.0 --port 7001
```

## 6. Testing the Pipeline
Once the Inference Node is running, you can test the STT worker directly over your local network before integrating it with the Node.js WebSockets.

Replace <PC_IP> with the local IP of your Inference Node (e.g., 192.168.1.3).

Bash
```
curl -X POST http://<PC_IP>:7001/transcribe \
     -H "Content-Type: application/octet-stream" \
     --data-binary @path/to/your/test_audio.wav
```
Expected JSON Response:

JSON
```
{
  "text": "This is a perfectly punctuated transcription of your audio file.",
  "compute_time_ms": 142.50
}
```
🛠️ Environment Variables
HF_HOME: Directory to cache the HuggingFace model weights.

MODEL_NAME: Defaults to nvidia/canary-qwen-2.5b. Can be swapped for lighter models if VRAM is constrained.