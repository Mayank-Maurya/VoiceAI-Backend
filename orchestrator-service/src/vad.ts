import type { ClientSession } from "./types";
import VAD from "node-vad";
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const VAD_FRAME_MS = 100;
export const VAD_FRAME_SAMPLES = (SAMPLE_RATE / 1000) * VAD_FRAME_MS;
export const VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * BYTES_PER_SAMPLE;

export async function sendToVadModel(session: ClientSession, frame: Buffer): Promise<void> {
    const stats = inspectPcm16(frame);
    const result = await session.vad.processAudio(frame, SAMPLE_RATE);
    const prefix =
    `[${session.id}] vad input size=${frame.length}B ` +
    `min=${stats.min} max=${stats.max} rms=${stats.rms.toFixed(2)} `;
  // const durationMs = (VAD_FRAME_SAMPLES / SAMPLE_RATE) * 1000;

  switch (result) {
    case VAD.Event.ERROR:
      console.error(prefix + "result=error");
      break;

    case VAD.Event.NOISE:
      console.log(prefix + "result=noise");
      break;

    case VAD.Event.SILENCE:
      console.log(prefix + "result=silence");
      break;

    case VAD.Event.VOICE:
      console.log(prefix + "result=voice");
      break;

    default:
      console.log(prefix + `result=unknown:${result}`);
  }


  // console.log(
  //   `[${session.id}] VAD frame ready ` +
  //     `size=${frame.length}B ` +
  //     `duration=${durationMs}ms`
  // );

  // Later:
  // vadModel.process(frame);
}

function inspectPcm16(frame: Buffer): {
  min: number;
  max: number;
  rms: number;
} {
  let min = 32767;
  let max = -32768;
  let sumSquares = 0;

  for (let i = 0; i < frame.length; i += BYTES_PER_SAMPLE) {
    const sample = frame.readInt16LE(i);
    min = Math.min(min, sample);
    max = Math.max(max, sample);
    sumSquares += sample * sample;
  }

  const sampleCount = frame.length / BYTES_PER_SAMPLE;
  const rms = Math.sqrt(sumSquares / sampleCount);

  return { min, max, rms };
}
