(function () {
  "use strict";

  var DEFAULT_WS_URL = "ws://localhost:3000/ws/audio";
  var DEFAULT_TARGET_SAMPLE_RATE = 16000;
  var DEFAULT_FRAME_DURATION_MS = 100;
  var WORKLET_URL = "./audio-worklet.js";
  var PLAYBACK_WORKLET_URL = "./audio-playback-worklet.js";
  var MAX_BUFFERED_BYTES = 1024 * 1024;
  var PLAYBACK_SAMPLE_RATE = 24000; // Kokoro output rate.
  var PRE_BUFFER_SAMPLES = PLAYBACK_SAMPLE_RATE * 0.05; // 50ms pre-buffer.

  var config = window.VOICE_AI_CONFIG || {};
  var websocketUrl = config.WS_URL || DEFAULT_WS_URL;
  var targetSampleRate = config.TARGET_SAMPLE_RATE || DEFAULT_TARGET_SAMPLE_RATE;
  var frameDurationMs = config.FRAME_DURATION_MS || DEFAULT_FRAME_DURATION_MS;

  var voiceStage = document.getElementById("voiceStage");
  var primaryStatus = document.getElementById("primaryStatus");
  var statusHint = document.getElementById("statusHint");
  var startButton = document.getElementById("startButton");
  var stopButton = document.getElementById("stopButton");
  var connectionStatus = document.getElementById("connectionStatus");
  var recordingStatus = document.getElementById("recordingStatus");
  var endpointValue = document.getElementById("endpointValue");
  var formatValue = document.getElementById("formatValue");
  var chunksSent = document.getElementById("chunksSent");
  var bytesSent = document.getElementById("bytesSent");
  var errorMessage = document.getElementById("errorMessage");

  var socket = null;
  var mediaStream = null;
  var audioContext = null;
  var sourceNode = null;
  var workletNode = null;
  var muteNode = null;
  var isStarting = false;
  var stopRequested = false;
  var chunkCount = 0;
  var byteCount = 0;
  var activityTimer = null;
  var voiceState = "idle";
  var lastVoiceAt = 0;

  // Streaming playback state.
  var streamingPlayer = null;
  var streamingReady = false;
  var streamingPendingChunks = [];

  endpointValue.textContent = websocketUrl;
  formatValue.textContent = "PCM16 mono, " + targetSampleRate + " Hz";
  setVoiceState("idle");
  setActivity(0);

  startButton.addEventListener("click", function () {
    startStreaming().catch(handleFatalStartError);
  });

  stopButton.addEventListener("click", function () {
    stopStreaming("Stopped");
  });

  window.addEventListener("beforeunload", function () {
    stopStreaming("Stopped");
  });

  updateControls();

  // ─── Streaming audio player ───

  function StreamingAudioPlayer() {
    this.playbackCtx = null;
    this.workletNode = null;
    this.isPlaying = false;
    this.preBuffered = 0;
    this.preBuffering = true;
    this.pendingSamples = [];
  }

  StreamingAudioPlayer.prototype.init = async function (sampleRate) {
    var rate = sampleRate || PLAYBACK_SAMPLE_RATE;

    if (this.playbackCtx) {
      await this.close();
    }

    this.playbackCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: rate,
    });

    await this.playbackCtx.audioWorklet.addModule(PLAYBACK_WORKLET_URL);

    this.workletNode = new AudioWorkletNode(
      this.playbackCtx,
      "streaming-playback-processor",
      { processorOptions: { sampleRate: rate } }
    );

    this.workletNode.connect(this.playbackCtx.destination);

    var self = this;
    this.workletNode.port.onmessage = function (event) {
      if (event.data.type === "ended") {
        self.isPlaying = false;
        restoreRecordingStatus();
      }
    };

    this.isPlaying = false;
    this.preBuffered = 0;
    this.preBuffering = true;
    this.pendingSamples = [];
  };

  StreamingAudioPlayer.prototype.pushPcm16 = function (arrayBuffer) {
    if (!this.workletNode) return;

    // Convert PCM16 (Int16) to Float32 for the AudioWorklet.
    var int16 = new Int16Array(arrayBuffer);
    var float32 = new Float32Array(int16.length);
    for (var i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    if (this.preBuffering) {
      this.pendingSamples.push(float32);
      this.preBuffered += float32.length;

      if (this.preBuffered >= PRE_BUFFER_SAMPLES) {
        this.preBuffering = false;
        this.workletNode.port.postMessage({ type: "start" });

        for (var j = 0; j < this.pendingSamples.length; j++) {
          var s = this.pendingSamples[j];
          this.workletNode.port.postMessage({ type: "samples", samples: s }, [s.buffer]);
        }
        this.pendingSamples = [];
        this.isPlaying = true;
      }
      return;
    }

    this.workletNode.port.postMessage({ type: "samples", samples: float32 }, [float32.buffer]);
  };

  StreamingAudioPlayer.prototype.drain = function () {
    if (!this.workletNode) return;

    // If still pre-buffering, flush whatever we have and start playback.
    if (this.preBuffering && this.pendingSamples.length > 0) {
      this.preBuffering = false;
      this.workletNode.port.postMessage({ type: "start" });

      for (var j = 0; j < this.pendingSamples.length; j++) {
        var s = this.pendingSamples[j];
        this.workletNode.port.postMessage({ type: "samples", samples: s }, [s.buffer]);
      }
      this.pendingSamples = [];
      this.isPlaying = true;
    }

    this.workletNode.port.postMessage({ type: "drain" });
  };

  StreamingAudioPlayer.prototype.stop = function () {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: "stop" });
    }
    this.isPlaying = false;
    this.preBuffered = 0;
    this.preBuffering = true;
    this.pendingSamples = [];
  };

  StreamingAudioPlayer.prototype.close = async function () {
    this.stop();
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.playbackCtx && this.playbackCtx.state !== "closed") {
      await this.playbackCtx.close();
    }
    this.playbackCtx = null;
  };

  // ─── Socket message handling (supports both streaming and legacy WAV) ───

  function handleSocketMessage(event) {
    var data = event.data;

    // Binary frame: either a legacy WAV or a streaming PCM16 chunk.
    if (data instanceof ArrayBuffer) {
      if (streamingPlayer) {
        if (streamingReady) {
          streamingPlayer.pushPcm16(data);
        } else {
          // Worklet still loading — queue chunks for when it's ready.
          streamingPendingChunks.push(data);
        }
        return;
      }

      // Legacy path: complete WAV.
      enqueueAudioResponse(data);
      return;
    }

    if (typeof Blob !== "undefined" && data instanceof Blob) {
      data.arrayBuffer().then(function (buf) {
        handleSocketMessage({ data: buf });
      }).catch(function () {});
      return;
    }

    // Text frame: JSON control message.
    if (typeof data === "string") {
      try {
        var msg = JSON.parse(data);
        handleControlMessage(msg);
      } catch (e) {
        // Not JSON — ignore.
      }
    }
  }

  function handleControlMessage(msg) {
    if (msg.type === "audio_start") {
      setStatus(recordingStatus, "Speaking", "speaking");
      setVoiceState("speaking");
      setActivity(0.72);

      streamingReady = false;
      streamingPendingChunks = [];

      if (!streamingPlayer) {
        streamingPlayer = new StreamingAudioPlayer();
      }
      streamingPlayer.init(msg.sampleRate || PLAYBACK_SAMPLE_RATE).then(function () {
        streamingReady = true;
        // Flush any chunks that arrived while the worklet was loading.
        if (streamingPlayer) {
          for (var i = 0; i < streamingPendingChunks.length; i++) {
            streamingPlayer.pushPcm16(streamingPendingChunks[i]);
          }
        }
        streamingPendingChunks = [];
      });
      return;
    }

    if (msg.type === "audio_end") {
      if (streamingPlayer) {
        streamingPlayer.drain();
      }
      return;
    }

    if (msg.type === "audio_cancel") {
      if (streamingPlayer) {
        streamingPlayer.stop();
      }
      streamingReady = false;
      streamingPendingChunks = [];
      restoreRecordingStatus();
      return;
    }
  }

  // ─── Legacy WAV playback (kept for backward compat) ───

  var playbackQueue = [];
  var isPlaying = false;
  var currentPlayback = null;

  function enqueueAudioResponse(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return;
    playbackQueue.push(arrayBuffer);
    playNextResponse();
  }

  function playNextResponse() {
    if (isPlaying) return;
    var nextBuffer = playbackQueue.shift();
    if (!nextBuffer) {
      restoreRecordingStatus();
      return;
    }

    isPlaying = true;
    setStatus(recordingStatus, "Speaking", "speaking");
    setVoiceState("speaking");
    setActivity(0.72);

    var objectUrl = URL.createObjectURL(new Blob([nextBuffer], { type: "audio/wav" }));
    var audio = new Audio();
    audio.src = objectUrl;
    currentPlayback = audio;

    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      audio.removeEventListener("ended", finish);
      audio.removeEventListener("error", finish);
      URL.revokeObjectURL(objectUrl);
      if (currentPlayback === audio) currentPlayback = null;
      isPlaying = false;
      playNextResponse();
    }

    audio.addEventListener("ended", finish);
    audio.addEventListener("error", finish);
    var playResult = audio.play();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(function (error) {
        showError("Could not play AI audio response: " + formatError(error));
        finish();
      });
    }
  }

  // ─── Mic streaming (unchanged) ───

  async function startStreaming() {
    if (isStarting || audioContext) return;

    clearError();
    resetMetrics();
    stopRequested = false;
    isStarting = true;
    setStatus(connectionStatus, "Connecting", "connecting");
    setStatus(recordingStatus, "Waiting", "connecting");
    setVoiceState("connecting");
    updateControls();

    try {
      assertBrowserSupport();
      socket = await openWebSocket(websocketUrl);
      if (stopRequested) { await stopStreaming("Stopped"); return; }

      attachSocketHandlers(socket);
      setStatus(connectionStatus, "Connected", "connected");

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (stopRequested) { await stopStreaming("Stopped"); return; }

      await setupAudioPipeline();
      if (stopRequested) { await stopStreaming("Stopped"); return; }

      sendStartMessage();
      connectAudioGraph();
      setStatus(recordingStatus, "Recording", "recording");
      setVoiceState("listening");
    } catch (error) {
      var wasStopped = stopRequested;
      await stopStreaming("Idle");
      if (!wasStopped) showError(formatError(error));
    } finally {
      isStarting = false;
      updateControls();
    }
  }

  async function stopStreaming(label) {
    stopRequested = true;

    // Stop streaming playback.
    if (streamingPlayer) {
      await streamingPlayer.close();
      streamingPlayer = null;
    }
    streamingReady = false;
    streamingPendingChunks = [];

    // Stop legacy playback.
    stopPlayback();

    clearActivityTimer();
    setStatus(recordingStatus, "Stopping", "stopping");
    setVoiceState("connecting");

    if (workletNode) {
      workletNode.port.postMessage({ type: "stop" });
      workletNode.port.removeEventListener("message", handleWorkletMessage);
      workletNode.port.removeEventListener("messageerror", handleWorkletMessageError);
      workletNode.removeEventListener("processorerror", handleWorkletProcessorError);
      workletNode.disconnect();
      workletNode.port.close();
      workletNode = null;
    }

    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (muteNode) { muteNode.disconnect(); muteNode = null; }

    if (audioContext) {
      if (audioContext.state !== "closed") await audioContext.close();
      audioContext = null;
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach(function (track) { track.stop(); });
      mediaStream = null;
    }

    if (socket) {
      detachSocketHandlers(socket);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "Client stopped");
      }
      socket = null;
    }

    setStatus(connectionStatus, "Idle", "idle");
    setStatus(recordingStatus, label || "Idle", "idle");
    setVoiceState("idle");
    setActivity(0);
    updateControls();
  }

  function assertBrowserSupport() {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!window.WebSocket) throw new Error("This browser does not support WebSockets.");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser cannot access microphone input.");
    if (!AudioContextClass) throw new Error("This browser does not support Web Audio.");
  }

  async function setupAudioPipeline() {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    try {
      audioContext = new AudioContextClass({ sampleRate: targetSampleRate });
    } catch (error) {
      audioContext = new AudioContextClass();
    }
    if (!audioContext.audioWorklet) throw new Error("This browser does not support AudioWorklet.");
    await audioContext.audioWorklet.addModule(WORKLET_URL);

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pcm16-stream-processor", {
      processorOptions: { targetSampleRate: targetSampleRate, frameDurationMs: frameDurationMs },
    });
    muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    workletNode.port.addEventListener("message", handleWorkletMessage);
    workletNode.port.addEventListener("messageerror", handleWorkletMessageError);
    workletNode.addEventListener("processorerror", handleWorkletProcessorError);
    workletNode.port.start();

    if (audioContext.state === "suspended") await audioContext.resume();
  }

  function connectAudioGraph() {
    sourceNode.connect(workletNode);
    workletNode.connect(muteNode);
    muteNode.connect(audioContext.destination);
  }

  function sendStartMessage() {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open.");
    socket.send(JSON.stringify({
      type: "start",
      format: "pcm_s16le",
      sampleRate: targetSampleRate,
      inputSampleRate: audioContext.sampleRate,
      channels: 1,
      frameDurationMs: frameDurationMs,
    }));
  }

  function openWebSocket(url) {
    return new Promise(function (resolve, reject) {
      var pendingSocket;
      try {
        pendingSocket = new WebSocket(url);
        pendingSocket.binaryType = "arraybuffer";
        socket = pendingSocket;
      } catch (error) { reject(error); return; }

      var settled = false;
      function cleanup() {
        pendingSocket.removeEventListener("open", handleOpen);
        pendingSocket.removeEventListener("error", handleError);
        pendingSocket.removeEventListener("close", handleClose);
      }
      function settle(callback, value) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      }
      function handleOpen() { settle(resolve, pendingSocket); }
      function handleError() { settle(reject, new Error("WebSocket connection failed.")); }
      function handleClose(event) {
        settle(reject, new Error(event.reason || "WebSocket closed before recording started."));
      }
      pendingSocket.addEventListener("open", handleOpen);
      pendingSocket.addEventListener("error", handleError);
      pendingSocket.addEventListener("close", handleClose);
    });
  }

  function attachSocketHandlers(activeSocket) {
    activeSocket.addEventListener("message", handleSocketMessage);
    activeSocket.addEventListener("close", handleSocketClose);
    activeSocket.addEventListener("error", handleSocketError);
  }

  function detachSocketHandlers(activeSocket) {
    activeSocket.removeEventListener("message", handleSocketMessage);
    activeSocket.removeEventListener("close", handleSocketClose);
    activeSocket.removeEventListener("error", handleSocketError);
  }

  function restoreRecordingStatus() {
    if (stopRequested || !audioContext) return;
    setStatus(recordingStatus, "Recording", "recording");
    setVoiceState("listening");
  }

  function stopPlayback() {
    playbackQueue = [];
    isPlaying = false;
    if (currentPlayback) {
      try { currentPlayback.pause(); } catch (e) {}
      currentPlayback.src = "";
      currentPlayback = null;
    }
  }

  function handleWorkletMessage(event) {
    var message = event.data;
    if (!message || message.type !== "pcm" || !(message.buffer instanceof ArrayBuffer)) return;
    sendPcmFrame(message.buffer);
  }

  function sendPcmFrame(buffer) {
    if (stopRequested) return;

    // Drop mic frames while the AI is speaking.
    var isSpeaking = isPlaying || (streamingPlayer && streamingPlayer.isPlaying);
    if (isSpeaking) return;

    updateVoiceActivity(buffer);

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      stopStreaming("Stopped");
      showError("WebSocket is not open. Audio streaming stopped.");
      return;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      stopStreaming("Stopped");
      showError("WebSocket is buffering too much audio. Streaming stopped.");
      return;
    }

    try {
      socket.send(buffer);
      chunkCount += 1;
      byteCount += buffer.byteLength;
      chunksSent.textContent = String(chunkCount);
      bytesSent.textContent = formatBytes(byteCount);
    } catch (error) {
      stopStreaming("Stopped");
      showError(formatError(error));
    }
  }

  function handleSocketClose(event) {
    if (!stopRequested) {
      stopStreaming("Stopped");
      showError("WebSocket closed unexpectedly" + formatCloseCode(event) + ".");
    }
  }

  function handleSocketError() {
    if (!stopRequested) {
      stopStreaming("Stopped");
      showError("WebSocket error. Audio streaming stopped.");
    }
  }

  function handleWorkletMessageError() {
    stopStreaming("Stopped");
    showError("Audio worklet message failed.");
  }

  function handleWorkletProcessorError() {
    stopStreaming("Stopped");
    showError("Audio worklet processing failed.");
  }

  function handleFatalStartError(error) {
    stopStreaming("Idle");
    showError(formatError(error));
  }

  function resetMetrics() {
    chunkCount = 0;
    byteCount = 0;
    chunksSent.textContent = "0";
    bytesSent.textContent = "0 B";
  }

  function updateControls() {
    startButton.disabled = isStarting || Boolean(audioContext);
    stopButton.disabled = !isStarting && !audioContext && !socket && !mediaStream;
  }

  function setStatus(element, text, state) {
    element.textContent = text;
    element.dataset.state = state;
    if (element === connectionStatus && voiceStage) voiceStage.dataset.connectionState = state;
  }

  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    setStatus(connectionStatus, "Error", "error");
    setVoiceState("error");
  }

  function clearError() {
    errorMessage.textContent = "";
    errorMessage.hidden = true;
  }

  function formatError(error) { return error ? (error.message || String(error)) : "Unknown error."; }
  function formatCloseCode(event) { return event && event.code ? " (" + event.code + ")" : ""; }
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function setVoiceState(state) {
    voiceState = state;
    if (voiceStage) voiceStage.dataset.voiceState = state;
    var copy = getVoiceCopy(state);
    if (primaryStatus) primaryStatus.textContent = copy.title;
    if (statusHint) statusHint.textContent = copy.hint;
  }

  function getVoiceCopy(state) {
    if (state === "connecting") return { title: "Opening channel", hint: "Preparing the live voice stream." };
    if (state === "listening") return { title: "Listening", hint: "I am listening." };
    if (state === "thinking") return { title: "Thinking", hint: "Working on your last phrase." };
    if (state === "speaking") return { title: "Speaking", hint: "Response is playing." };
    if (state === "error") return { title: "Needs attention", hint: "Something interrupted the stream." };
    return { title: "Ready when you are", hint: "The room is quiet." };
  }

  function updateVoiceActivity(buffer) {
    var level = measurePcmActivity(buffer);
    setActivity(level);
    if (!audioContext || stopRequested || voiceState === "speaking") return;
    if (level > 0.08) {
      lastVoiceAt = Date.now();
      clearActivityTimer();
      if (voiceState !== "listening") setVoiceState("listening");
      activityTimer = setTimeout(function () {
        if (!stopRequested && audioContext && !isPlaying && !(streamingPlayer && streamingPlayer.isPlaying) && Date.now() - lastVoiceAt >= 800) {
          setVoiceState("thinking");
          setActivity(0.16);
        }
      }, 900);
    }
  }

  function measurePcmActivity(buffer) {
    if (!buffer || buffer.byteLength < 2) return 0;
    var samples = new Int16Array(buffer);
    var sum = 0;
    for (var i = 0; i < samples.length; i++) {
      var value = samples[i] / 32768;
      sum += value * value;
    }
    var rms = Math.sqrt(sum / samples.length);
    return Math.max(0, Math.min(1, rms * 8));
  }

  function setActivity(value) {
    if (!voiceStage) return;
    voiceStage.style.setProperty("--activity", String(Math.max(0, Math.min(1, value))));
  }

  function clearActivityTimer() {
    if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
  }
})();