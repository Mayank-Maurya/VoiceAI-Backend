window.VOICE_AI_CONFIG = {
  // For mobile on the same network, use the Mac's LAN IP (not localhost).
  WS_URL: "ws://192.168.1.4:3000/ws/audio",
  // WS_URL: "ws://localhost:3000/ws/audio",
  // WS_URL: "wss://voiceai-backend-v1lp.onrender.com/ws/audio",
  TARGET_SAMPLE_RATE: 16000,
  FRAME_DURATION_MS: 100
};
