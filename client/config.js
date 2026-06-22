window.VOICE_AI_CONFIG = {
  // WS_URL is auto-derived from the page's origin when left unset:
  //   page http://localhost:3000 -> ws://localhost:3000/ws/audio
  //   page https://xxx.ngrok.app -> wss://xxx.ngrok.app/ws/audio
  // Set it explicitly only if the client and orchestrator are on different hosts.
  // WS_URL: "ws://localhost:3000/ws/audio",
  // WS_URL: "ws://192.168.1.4:3000/ws/audio",
  // WS_URL: "wss://voiceai-backend-v1lp.onrender.com/ws/audio",
  TARGET_SAMPLE_RATE: 16000,
  FRAME_DURATION_MS: 100
};
