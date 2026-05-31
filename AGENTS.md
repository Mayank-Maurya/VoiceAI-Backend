# Voice AI High-Throughput Backend: System Architecture & Agent Configuration

## 1. What We Are Building
We are building a highly concurrent Voice AI system heavily indexed on backend I/O performance, paired with a thin, lightweight frontend client. The frontend acts solely as a pass-through layer, capturing raw audio input and streaming it over a persistent connection. The backend is an ultra-high-throughput inference orchestration engine designed to ingest continuous voice data, route it through an event-driven architecture, and stream generative responses back with ultra-low latency.

## 2. Why We Are Building It
To achieve enterprise-grade conversational AI at an extreme scale. The system is explicitly architected to handle a sustained throughput of 470 billion tokens per day, translating to peak inference loads of approximately 5.4 million tokens per second. Hitting this target requires moving beyond standard synchronous REST paradigms in favor of highly optimized event loops, distributed message brokering, and highly parallelized data pipelines.

## 3. What Things It Should Use (Tech Stack & Toolkit)
- **Core Backend Orchestration:** Node.js. Used as the primary I/O multiplexer to handle thousands of concurrent persistent connections efficiently via its event-driven, non-blocking architecture. 
- **Database:** PostgreSQL. Used for durable, relational storage of user metadata, session histories, and system configuration.
- **Message Broking:** Apache Kafka. The backbone of the high-throughput pipeline. Used to decouple the Node.js API layer from the heavy GPU inference clusters, safely queuing millions of token events per second.
- **Caching & State:** Redis. Used for ultra-low latency access to session states, rate limiting, and temporary buffering of active conversation context.
- **Networking & Transport:** 
  - **WebSockets:** For persistent, bidirectional, real-time binary audio streaming between the frontend client and the Node.js gateway.
  - **gRPC:** For high-performance, strongly-typed internal microservice communication (e.g., between the Node.js orchestrator and the Python/C++ inference servers).

## 4. Global Agent Rules (System Prompts)
*These constraints apply universally to all coding and architecture agents working on this repository.*

- **Event Loop Protection:** Under no circumstances should backend code block the Node.js Event Loop. CPU-intensive tasks (like heavy audio buffering or synchronous serialization) must be offloaded to worker threads or external services.
- **Strict Stream Management:** Agents must heavily utilize Node.js Streams API for handling audio buffers. Never accumulate large raw audio files in memory; stream data directly from WebSockets to Kafka/gRPC.
- **Memory Leak Vigilance:** At 5.4M tokens/sec, memory leaks are fatal. Agents must ensure all event listeners are properly removed, WebSocket connections are explicitly closed, and variables are scoped to allow immediate garbage collection.
- **Resilient I/O Handling:** Network drops, malformed audio chunks, and Kafka backpressure are expected. Agents must implement graceful error handling—never crash the main process—and ensure application states recover cleanly from corrupted streams.

<claude-mem-context>
# Memory Context

# [VoiceAI-Backend] recent context, 2026-06-01 5:16am GMT+5:30

No previous sessions found.
</claude-mem-context>