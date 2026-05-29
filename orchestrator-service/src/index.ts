import http from "node:http";
import { WebSocketServer } from "ws";
import { PORT, WS_PATH } from "./config";
import { addConnection, handleAudio, removeConnection } from "./session/sessionManager";

const server = http.createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
});

// Handle WebSocket upgrades ourselves so we can reject unknown paths.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    if (url.pathname !== WS_PATH) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
    });
});

wss.on("connection", (socket) => {
    const session = addConnection(socket);

    socket.on("message", (data, isBinary) => {
        handleAudio(session, data, isBinary);
    });

    socket.on("close", () => {
        removeConnection(session);
    });

    socket.on("error", (error) => {
        console.error(`[${session.id}] websocket error`, error);
    });
});

server.listen(PORT, () => {
    console.log(`HTTP server listening on http://localhost:${PORT}`);
    console.log(`WebSocket endpoint ready at ws://localhost:${PORT}${WS_PATH}`);
});
