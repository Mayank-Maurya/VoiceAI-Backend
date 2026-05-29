(function () {
  "use strict";

  var DEFAULT_WS_URL = "ws://localhost:3000/ws/audio";
  var DEFAULT_TARGET_SAMPLE_RATE = 16000;
  var DEFAULT_FRAME_DURATION_MS = 100;
  var WORKLET_URL = "./audio-worklet.js";
  var MAX_BUFFERED_BYTES = 1024 * 1024;

  var config = window.VOICE_AI_CONFIG || {};
  var websocketUrl = config.WS_URL || DEFAULT_WS_URL;
  var targetSampleRate = config.TARGET_SAMPLE_RATE || DEFAULT_TARGET_SAMPLE_RATE;
  var frameDurationMs = config.FRAME_DURATION_MS || DEFAULT_FRAME_DURATION_MS;

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
  var playbackQueue = [];
  var isPlaying = false;
  var currentPlayback = null;

  endpointValue.textContent = websocketUrl;
  formatValue.textContent = "PCM16 mono, " + targetSampleRate + " Hz";

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

  async function startStreaming() {
    if (isStarting || audioContext) {
      return;
    }

    clearError();
    resetMetrics();
    stopRequested = false;
    isStarting = true;
    setStatus(connectionStatus, "Connecting", "connecting");
    setStatus(recordingStatus, "Waiting", "connecting");
    updateControls();

    try {
      assertBrowserSupport();
      socket = await openWebSocket(websocketUrl);
      if (stopRequested) {
        await stopStreaming("Stopped");
        return;
      }

      attachSocketHandlers(socket);
      setStatus(connectionStatus, "Connected", "connected");

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      if (stopRequested) {
        await stopStreaming("Stopped");
        return;
      }

      await setupAudioPipeline();
      if (stopRequested) {
        await stopStreaming("Stopped");
        return;
      }

      sendStartMessage();
      connectAudioGraph();
      setStatus(recordingStatus, "Recording", "recording");
    } catch (error) {
      var wasStopped = stopRequested;
      await stopStreaming("Idle");
      if (!wasStopped) {
        showError(formatError(error));
      }
    } finally {
      isStarting = false;
      updateControls();
    }
  }

  async function stopStreaming(label) {
    stopRequested = true;
    stopPlayback();
    setStatus(recordingStatus, "Stopping", "stopping");

    if (workletNode) {
      workletNode.port.postMessage({ type: "stop" });
      workletNode.port.removeEventListener("message", handleWorkletMessage);
      workletNode.port.removeEventListener("messageerror", handleWorkletMessageError);
      workletNode.removeEventListener("processorerror", handleWorkletProcessorError);
      workletNode.disconnect();
      workletNode.port.close();
      workletNode = null;
    }

    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }

    if (muteNode) {
      muteNode.disconnect();
      muteNode = null;
    }

    if (audioContext) {
      if (audioContext.state !== "closed") {
        await audioContext.close();
      }
      audioContext = null;
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach(function (track) {
        track.stop();
      });
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
    updateControls();
  }

  function assertBrowserSupport() {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!window.WebSocket) {
      throw new Error("This browser does not support WebSockets.");
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser cannot access microphone input.");
    }

    if (!AudioContextClass) {
      throw new Error("This browser does not support Web Audio.");
    }
  }

  async function setupAudioPipeline() {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;

    try {
      audioContext = new AudioContextClass({
        sampleRate: targetSampleRate
      });
    } catch (error) {
      audioContext = new AudioContextClass();
    }

    if (!audioContext.audioWorklet) {
      throw new Error("This browser does not support AudioWorklet.");
    }

    await audioContext.audioWorklet.addModule(WORKLET_URL);

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pcm16-stream-processor", {
      processorOptions: {
        targetSampleRate: targetSampleRate,
        frameDurationMs: frameDurationMs
      }
    });
    muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    workletNode.port.addEventListener("message", handleWorkletMessage);
    workletNode.port.addEventListener("messageerror", handleWorkletMessageError);
    workletNode.addEventListener("processorerror", handleWorkletProcessorError);
    workletNode.port.start();

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  function connectAudioGraph() {
    sourceNode.connect(workletNode);
    workletNode.connect(muteNode);
    muteNode.connect(audioContext.destination);
  }

  function sendStartMessage() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open.");
    }

    socket.send(JSON.stringify({
      type: "start",
      format: "pcm_s16le",
      sampleRate: targetSampleRate,
      inputSampleRate: audioContext.sampleRate,
      channels: 1,
      frameDurationMs: frameDurationMs
    }));
  }

  function openWebSocket(url) {
    return new Promise(function (resolve, reject) {
      var pendingSocket;

      try {
        pendingSocket = new WebSocket(url);
        pendingSocket.binaryType = "arraybuffer";
        socket = pendingSocket;
      } catch (error) {
        reject(error);
        return;
      }

      var settled = false;

      function cleanup() {
        pendingSocket.removeEventListener("open", handleOpen);
        pendingSocket.removeEventListener("error", handleError);
        pendingSocket.removeEventListener("close", handleClose);
      }

      function settle(callback, value) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback(value);
      }

      function handleOpen() {
        settle(resolve, pendingSocket);
      }

      function handleError() {
        settle(reject, new Error("WebSocket connection failed."));
      }

      function handleClose(event) {
        var reason = event.reason || "WebSocket closed before recording started.";
        settle(reject, new Error(reason));
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

  // Incoming server messages: binary frames are the AI's TTS audio (WAV).
  function handleSocketMessage(event) {
    var data = event.data;

    if (data instanceof ArrayBuffer) {
      enqueueAudioResponse(data);
      return;
    }

    if (typeof Blob !== "undefined" && data instanceof Blob) {
      data.arrayBuffer().then(enqueueAudioResponse).catch(function () {});
      return;
    }

    // Text/JSON control messages are not used yet; ignore them.
  }

  function enqueueAudioResponse(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      return;
    }

    playbackQueue.push(arrayBuffer);
    playNextResponse();
  }

  // Plays queued responses one after another so replies never overlap.
  function playNextResponse() {
    if (isPlaying) {
      return;
    }

    var nextBuffer = playbackQueue.shift();
    if (!nextBuffer) {
      restoreRecordingStatus();
      return;
    }

    isPlaying = true;
    setStatus(recordingStatus, "Speaking", "speaking");

    var objectUrl = URL.createObjectURL(new Blob([nextBuffer], { type: "audio/wav" }));
    var audio = new Audio();
    audio.src = objectUrl;
    currentPlayback = audio;

    var finished = false;
    function finish() {
      if (finished) {
        return;
      }
      finished = true;
      audio.removeEventListener("ended", finish);
      audio.removeEventListener("error", finish);
      URL.revokeObjectURL(objectUrl);
      if (currentPlayback === audio) {
        currentPlayback = null;
      }
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

  function restoreRecordingStatus() {
    if (stopRequested || !audioContext) {
      return;
    }
    setStatus(recordingStatus, "Recording", "recording");
  }

  function stopPlayback() {
    playbackQueue = [];
    isPlaying = false;
    if (currentPlayback) {
      try {
        currentPlayback.pause();
      } catch (error) {
        // Ignore teardown errors.
      }
      currentPlayback.src = "";
      currentPlayback = null;
    }
  }

  function handleWorkletMessage(event) {
    var message = event.data;

    if (!message || message.type !== "pcm" || !(message.buffer instanceof ArrayBuffer)) {
      return;
    }

    sendPcmFrame(message.buffer);
  }

  function sendPcmFrame(buffer) {
    if (stopRequested) {
      return;
    }

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
  }

  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    setStatus(connectionStatus, "Error", "error");
  }

  function clearError() {
    errorMessage.textContent = "";
    errorMessage.hidden = true;
  }

  function formatError(error) {
    if (!error) {
      return "Unknown error.";
    }
    return error.message || String(error);
  }

  function formatCloseCode(event) {
    return event && event.code ? " (" + event.code + ")" : "";
  }

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return bytes + " B";
    }

    if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(1) + " KB";
    }

    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }
})();
