import { BYTES_PER_SAMPLE } from "../config";

/**
 * Root-mean-square amplitude of a PCM16 frame, on the 0..32767 sample scale.
 * Used as an energy gate so quiet ambient frames don't register as speech.
 */
export function computeRms(frame: Buffer): number {
    const sampleCount = Math.floor(frame.length / BYTES_PER_SAMPLE);
    if (sampleCount === 0) {
        return 0;
    }

    let sumSquares = 0;
    for (let i = 0; i + BYTES_PER_SAMPLE <= frame.length; i += BYTES_PER_SAMPLE) {
        const sample = frame.readInt16LE(i);
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / sampleCount);
}
