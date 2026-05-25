declare module "node-vad" {
  import type { Transform } from "node:stream";

  type VadEvent = -1 | 0 | 1 | 2;
  type VadMode = 0 | 1 | 2 | 3;

  type VadStreamOptions = {
    mode?: VadMode;
    audioFrequency?: 8000 | 16000 | 32000 | 48000;
    debounceTime?: number;
  };

  type VadStreamOutput = {
    time: number;
    audioData: Buffer;
    speech: {
      state: boolean;
      start: boolean;
      end: boolean;
      startTime: number;
      duration: number;
    };
  };

  class VAD {
    constructor(mode: VadMode);

    processAudio(buffer: Buffer, rate: 8000 | 16000 | 32000 | 48000): Promise<VadEvent>;

    processAudioFloat(
      buffer: Buffer,
      rate: 8000 | 16000 | 32000 | 48000
    ): Promise<VadEvent>;

    static createStream(options?: VadStreamOptions): Transform;

    static toFloatBuffer(buffer: Buffer): Buffer;

    static Event: {
      ERROR: -1;
      SILENCE: 0;
      VOICE: 1;
      NOISE: 2;
    };

    static Mode: {
      NORMAL: 0;
      LOW_BITRATE: 1;
      AGGRESSIVE: 2;
      VERY_AGGRESSIVE: 3;
    };
  }

  export = VAD;
}