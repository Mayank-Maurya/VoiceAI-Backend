# Voice AI Backend

Node.js TypeScript WebSocket server for receiving streamed audio chunks.

## Run

```bash
cd backend
npm install
npm run dev
```

WebSocket endpoint:

```text
ws://localhost:3000/ws/audio
```

## Flow

```mermaid
flowchart TD
    A["Browser microphone"] --> B["MediaRecorder 250ms audio chunks"]
    B --> C["Frontend WebSocket client"]
    C --> D["ws://localhost:3000/ws/audio"]
    D --> E["Node.js upgrade handler"]
    E --> F["WebSocket server"]
    F --> G["Connection manager"]
    G --> H["Log chunk size and timing"]
```

## Logs

Each binary audio chunk logs its chunk number, size, timestamp, elapsed connection time, previous-chunk gap, and total bytes received.
