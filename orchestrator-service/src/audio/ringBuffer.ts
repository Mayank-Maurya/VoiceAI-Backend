/**
 * Accumulates arbitrarily-sized incoming chunks and emits fixed-size frames.
 *
 * Audio arrives in chunks that don't line up with the VAD's required frame
 * size, so we buffer bytes until a full frame (default 3200 bytes = one 100ms
 * frame of 16kHz 16-bit mono audio) is ready, then flush it via `onFull`.
 */
export class RingBuffer {
    private readonly buffer: Buffer;
    private readonly bufferSize: number;
    private offset = 0;

    constructor(bufferSize: number = 3200) {
        this.bufferSize = bufferSize;
        this.buffer = Buffer.allocUnsafe(bufferSize);
    }

    get filledBytes(): number {
        return this.offset;
    }

    clear(): void {
        this.offset = 0;
    }

    append(chunk: Buffer, onFull: (frame: Buffer) => void): void {
        let chunkOffset = 0;

        while (chunkOffset < chunk.length) {
            const remainingBufferSpace = this.bufferSize - this.offset;
            const remainingChunkBytes = chunk.length - chunkOffset;
            const bytesToCopy = Math.min(remainingBufferSpace, remainingChunkBytes);

            chunk.copy(this.buffer, this.offset, chunkOffset, chunkOffset + bytesToCopy);

            this.offset += bytesToCopy;
            chunkOffset += bytesToCopy;

            // A complete frame is ready: hand out a copy and reset for the next one.
            if (this.offset === this.bufferSize) {
                onFull(Buffer.from(this.buffer));
                this.clear();
            }
        }
    }
}
