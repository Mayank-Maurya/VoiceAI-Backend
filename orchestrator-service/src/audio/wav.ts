import { BYTES_PER_SAMPLE, SAMPLE_RATE } from "../config";

/**
 * Builds a 44-byte PCM WAV header for the given amount of 16-bit mono audio.
 * The processing engine expects a self-contained WAV file, so raw PCM frames
 * captured from the client are wrapped with this header before being sent.
 */
export function generateWavHeader(dataLength: number, sampleRate = SAMPLE_RATE): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // audio format = PCM
    header.writeUInt16LE(1, 22); // channels = mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28); // byte rate
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
}
