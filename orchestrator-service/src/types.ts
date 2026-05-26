import type { RawData, WebSocket } from "ws";
import { RingBuffer } from "./staticRingBuffer";
import VAD from "node-vad";

export type ClientSession = {
    id: string;
    socket: WebSocket;
    connectedAt: number;
    lastChunkAt: number;
    chunksRecieved: number;
    bytesRecieved: number;
    vadFramesSent: number;
    vadBuffer: RingBuffer;
    vad: VAD;
    vadWork: Promise<void>,
    isSpeaking?: boolean;
    utteranceBuffer?: Buffer;
};

export type AudioMessage = {
    data: RawData;
    isBinary: boolean;
};
