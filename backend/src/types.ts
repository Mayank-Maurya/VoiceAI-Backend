import type { RawData, WebSocket } from "ws";

export type ClientSession = {
    id: string;
    socket: WebSocket;
    connectedAt: number;
    lastChunkAt: number;
    chunksRecieved: number;
    bytesRecieved: number;
};

export type AudioMessage = {
    data: RawData;
    isBinary: boolean;
};