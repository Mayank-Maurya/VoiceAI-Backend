import type { RawData, WebSocket } from "ws";
import { RingBuffer } from "./staticRingBuffer";

export type ClientSession = {
    id: string;
    socket: WebSocket;
    connectedAt: number;
    lastChunkAt: number;
    chunksRecieved: number;
    bytesRecieved: number;
    vadFramesSent: number;
    vadBuffer: RingBuffer;
};

export type AudioMessage = {
    data: RawData;
    isBinary: boolean;
};