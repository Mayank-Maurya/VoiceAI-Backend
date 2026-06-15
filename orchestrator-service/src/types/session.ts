import type { WebSocket as BrowserSocket } from "ws";
import type WebSocket from "ws";
import { RingBuffer } from "../audio/ringBuffer";

export type ClientSession = {
    id: string;
    socket: BrowserSocket;
    connectedAt: number;

    chunksReceived: number;
    bytesReceived: number;

    vadBuffer: RingBuffer;

    sttSocket: WebSocket | null;
    silenceFrames: number;
    silenceSent: boolean;
};
