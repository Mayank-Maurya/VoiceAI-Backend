export class RingBuffer {
    private readonly buffer: Buffer;
    private readonly bufferSize: number;
    private offset = 0;
    constructor(bufferSize: number = 65536) {
        this.bufferSize = bufferSize;
        this.buffer = Buffer.allocUnsafe(bufferSize);
    }

    get filledBytes(): number {
        return this.offset;
    }

    clear() {
        this.offset = 0;
    }

    append(chunk: Buffer, onFull: (frame: Buffer) => void): void {
        let chunkOffset = 0;
        while(chunkOffset < chunk.length) {
            const remainingBufferSpace = this.bufferSize - this.offset;
            const remainingChunkBytes = chunk.length - chunkOffset;
            const bytesToCopy = Math.min(remainingBufferSpace, remainingChunkBytes);

            chunk.copy(
                this.buffer,
                this.offset,
                chunkOffset,
                chunkOffset + bytesToCopy
            );

            this.offset += bytesToCopy;
            chunkOffset += bytesToCopy;

            if (this.offset == this.bufferSize) {
                onFull(Buffer.from(this.buffer));
                this.clear();
            }
        }
    }


}