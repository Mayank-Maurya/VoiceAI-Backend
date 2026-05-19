class Pcm16StreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    var processorOptions = options.processorOptions || {};
    this.targetSampleRate = processorOptions.targetSampleRate || 16000;
    this.frameDurationMs = processorOptions.frameDurationMs || 100;
    this.inputToOutputRatio = sampleRate / this.targetSampleRate;
    this.nextInputFrame = 0;
    this.frameSamples = Math.max(
      1,
      Math.round(this.targetSampleRate * this.frameDurationMs / 1000)
    );
    this.frame = new Int16Array(this.frameSamples);
    this.frameOffset = 0;
    this.stopped = false;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "stop") {
        this.flushFrame();
        this.stopped = true;
      }
    };
  }

  process(inputs) {
    if (this.stopped) {
      return false;
    }

    var channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) {
      return true;
    }

    var inputLength = channels[0].length;
    var position = this.nextInputFrame;

    while (position < inputLength) {
      this.writeSample(this.readMonoSample(channels, position, inputLength));
      position += this.inputToOutputRatio;
    }

    this.nextInputFrame = position - inputLength;
    return true;
  }

  readMonoSample(channels, position, inputLength) {
    var index = Math.floor(position);
    var fraction = position - index;
    var total = 0;

    for (var channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      var channel = channels[channelIndex];
      var current = channel[index] || 0;
      var next = index + 1 < inputLength ? channel[index + 1] : current;
      total += current + (next - current) * fraction;
    }

    return total / channels.length;
  }

  writeSample(floatSample) {
    var clamped = Math.max(-1, Math.min(1, floatSample));
    var pcmSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

    this.frame[this.frameOffset] = pcmSample;
    this.frameOffset += 1;

    if (this.frameOffset === this.frameSamples) {
      this.postFrame(this.frame, this.frameSamples);
      this.frame = new Int16Array(this.frameSamples);
      this.frameOffset = 0;
    }
  }

  flushFrame() {
    if (this.frameOffset === 0) {
      return;
    }

    this.postFrame(this.frame.slice(0, this.frameOffset), this.frameOffset);
    this.frame = new Int16Array(this.frameSamples);
    this.frameOffset = 0;
  }

  postFrame(frame, samples) {
    this.port.postMessage({
      type: "pcm",
      buffer: frame.buffer,
      samples: samples,
      sampleRate: this.targetSampleRate
    }, [frame.buffer]);
  }
}

registerProcessor("pcm16-stream-processor", Pcm16StreamProcessor);
