"""RabbitMQ TTS worker: consumes text jobs and replies with WAV bytes."""

import json
import os
import sys
import time
from typing import Any

import pika

from app.models import stt_runtime

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://localhost")
TTS_JOBS_QUEUE = os.getenv("TTS_JOBS_QUEUE", "tts.jobs")
TTS_PREFETCH = int(os.getenv("TTS_PREFETCH", "1"))

runtime = stt_runtime

def main() -> None:
    print("Loading TTS runtime...", flush=True)
    runtime.load()
    print("TTS worker ready.", flush=True)

    params = pika.URLParameters(RABBITMQ_URL)
    connection = pika.BlockingConnection(params)
    channel = connection.channel()

    channel.queue_declare(queue=TTS_JOBS_QUEUE, durable=True)
    channel.basic_qos(prefetch_count=TTS_PREFETCH)

    channel.basic_consume(
        queue=TTS_JOBS_QUEUE,
        on_message_callback=handle_message,
        auto_ack=False,
    )

    print(f"Consuming queue={TTS_JOBS_QUEUE} prefetch={TTS_PREFETCH}", flush=True)
    channel.start_consuming()


def handle_message(channel: Any, method: Any, properties: Any, body: bytes) -> None:
    started_at = time.perf_counter()
    reply_to = properties.reply_to
    correlation_id = properties.correlation_id

    if not reply_to or not correlation_id:
        print("Rejecting TTS job without reply_to/correlation_id", flush=True)
        channel.basic_reject(delivery_tag=method.delivery_tag, requeue=False)
        return

    try:
        request = json.loads(body.decode("utf-8"))
        text = str(request.get("text", "")).strip()

        if not text:
            raise ValueError("Missing text")

        wav_bytes = runtime.generate_audio_bytes(text)

        channel.basic_publish(
            exchange="",
            routing_key=reply_to,
            properties=pika.BasicProperties(
                correlation_id=correlation_id,
                content_type="audio/wav",
                headers={
                    "computeMs": round((time.perf_counter() - started_at) * 1000, 1),
                },
            ),
            body=wav_bytes,
        )

        channel.basic_ack(delivery_tag=method.delivery_tag)

    except Exception as error:
        error_response = {
            "stage": "tts",
            "error": str(error),
        }

        channel.basic_publish(
            exchange="",
            routing_key=reply_to,
            properties=pika.BasicProperties(
                correlation_id=correlation_id,
                content_type="application/json",
            ),
            body=json.dumps(error_response).encode("utf-8"),
        )

        channel.basic_ack(delivery_tag=method.delivery_tag)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)