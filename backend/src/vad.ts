import type { ClientSession } from "./types";

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 64;
export const VAD_FRAME_SAMPLES = 1024;
export const VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * BYTES_PER_SAMPLE;

export function sendToVadModel(session: ClientSession, frame: Buffer): void {
  const durationMs = (VAD_FRAME_SAMPLES / SAMPLE_RATE) * 1000;

  console.log(
    `[${session.id}] VAD frame ready ` +
      `size=${frame.length}B ` +
      `duration=${durationMs}ms`
  );

  // Later:
  // vadModel.process(frame);
}