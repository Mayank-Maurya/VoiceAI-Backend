(function () {
  "use strict";

  var DEFAULT_WS_URL = "ws://localhost:3000/ws/audio";
  var AUDIO_MIME_TYPE = "audio/webm;codecs=opus";
  var CHUNK_TIMESLICE_MS = 250;
  var MAX_BUFFERED_BYTES = 1024 * 1024;

  var config = window.VOICE_AI_CONFIG || {};
  var websocketUrl = config.WS_URL || DEFAULT_WS_URL;

  var startButton = document.getElementById("startButton");
  var stopButton = document.getElementById("stopButton");
  var connectionStatus = document.getElementById("connectionStatus");
  var recordingStatus = document.getElementById("recordingStatus");
  var endpointValue = document.getElementById("endpointValue");
  var chunksSent = document.getElementById("chunksSent");
  var bytesSent = document.getElementById("bytesSent");
  var errorMessage = document.getElementById("errorMessage");

  var socket = null;
  var mediaStream = null;
  var recorder = null;
  var isStarting = false;
  var stopRequested = false;
  var chunkCount = 0;
  var byteCount = 0;

  endpointValue.textContent = websocketUrl;

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
    if (isStarting || recorder) {
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
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      if (stopRequested) {
        await stopStreaming("Stopped");
        return;
      }

      recorder = new MediaRecorder(mediaStream, {
        mimeType: AUDIO_MIME_TYPE
      });
      recorder.addEventListener("dataavailable", handleAudioChunk);
      recorder.addEventListener("error", handleRecorderError);
      recorder.start(CHUNK_TIMESLICE_MS);

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
    setStatus(recordingStatus, "Stopping", "stopping");

    if (recorder) {
      recorder.removeEventListener("dataavailable", handleAudioChunk);
      recorder.removeEventListener("error", handleRecorderError);
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      recorder = null;
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
    if (!window.WebSocket) {
      throw new Error("This browser does not support WebSockets.");
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser cannot access microphone input.");
    }

    if (!window.MediaRecorder) {
      throw new Error("This browser does not support MediaRecorder.");
    }

    if (!MediaRecorder.isTypeSupported(AUDIO_MIME_TYPE)) {
      throw new Error("This browser cannot record " + AUDIO_MIME_TYPE + ".");
    }
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
    activeSocket.addEventListener("close", handleSocketClose);
    activeSocket.addEventListener("error", handleSocketError);
  }

  function detachSocketHandlers(activeSocket) {
    activeSocket.removeEventListener("close", handleSocketClose);
    activeSocket.removeEventListener("error", handleSocketError);
  }

  function handleAudioChunk(event) {
    if (!event.data || event.data.size === 0) {
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
      socket.send(event.data);
      chunkCount += 1;
      byteCount += event.data.size;
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

  function handleRecorderError(event) {
    var message = event.error ? event.error.message : "MediaRecorder error.";
    stopStreaming("Stopped");
    showError(message);
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
    startButton.disabled = isStarting || Boolean(recorder);
    stopButton.disabled = !isStarting && !recorder && !socket && !mediaStream;
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
