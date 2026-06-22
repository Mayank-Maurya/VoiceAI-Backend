import type { WebSocket as BrowserSocket } from "ws";
import type WebSocket from "ws";
import { RingBuffer } from "../audio/ringBuffer";

export type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

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

    // Timestamp (ms) of the most recent voiced frame — used to measure
    // perceived latency: from when the user actually stopped speaking to
    // the first audio byte sent back.
    lastVoiceAt: number;

    history: ChatMessage[];
    turnAbort: AbortController | null;
};
