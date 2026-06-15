/**
 * AudioWorklet processor for streaming PCM16 playback.
 *
 * Receives PCM16 samples via the message port, buffers them in a ring buffer,
 * and pulls from the buffer each render quantum (128 samples).
 * Outputs silence when the buffer is empty (graceful underrun).
 */
class StreamingPlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // Ring buffer: 2 seconds at the given sample rate.
    const sampleRate = options.processorOptions?.sampleRate ?? 24000;
    this._bufferSize = sampleRate * 2;
    this._buffer = new Float32Array(this._bufferSize);
    this._writePos = 0;
    this._readPos = 0;
    this._samplesAvailable = 0;
    this._active = false;
    this._draining = false;

    this.port.onmessage = (event) => {
      const msg = event.data;

      if (msg.type === "samples") {
        this._pushSamples(msg.samples);
      } else if (msg.type === "start") {
        this._active = true;
        this._draining = false;
      } else if (msg.type === "drain") {
        // No more chunks coming — play what's left then stop.
        this._draining = true;
      } else if (msg.type === "stop") {
        this._active = false;
        this._draining = false;
        this._writePos = 0;
        this._readPos = 0;
        this._samplesAvailable = 0;
      }
    };
  }

  _pushSamples(float32Array) {
    for (let i = 0; i < float32Array.length; i++) {
      if (this._samplesAvailable >= this._bufferSize) {
        break; // Buffer full — drop overflow.
      }
      this._buffer[this._writePos] = float32Array[i];
      this._writePos = (this._writePos + 1) % this._bufferSize;
      this._samplesAvailable++;
    }
  }

  process(inputs, outputs) {
    if (!this._active) {
      return true; // Keep processor alive but output silence.
    }

    const output = outputs[0][0]; // Mono output channel.
    if (!output) return true;

    for (let i = 0; i < output.length; i++) {
      if (this._samplesAvailable > 0) {
        output[i] = this._buffer[this._readPos];
        this._readPos = (this._readPos + 1) % this._bufferSize;
        this._samplesAvailable--;
      } else {
        output[i] = 0; // Underrun — output silence.
      }
    }

    // If draining and buffer is empty, we're done.
    if (this._draining && this._samplesAvailable === 0) {
      this._active = false;
      this._draining = false;
      this.port.postMessage({ type: "ended" });
    }

    return true;
  }
}

registerProcessor("streaming-playback-processor", StreamingPlaybackProcessor);