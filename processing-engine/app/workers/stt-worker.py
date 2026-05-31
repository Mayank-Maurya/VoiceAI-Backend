"""RabbitMQ STT worker: consumes WAV jobs and replies with transcripts."""

import json
import os
import sys
import time
from typing import Any

import pika

from ..models import stt_runtime 

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://localhost")
STT_JOBS_QUEUE = os.getenv("STT_JOBS_QUEUE", "stt.jobs")
STT_PREFETCH = int(os.getenv("STT_PREFETCH", "1"))

runtime = stt_runtimew

def main() -> None:
    print("Loading STT runtime...", flush=True)
    runtime.load()
    print("STT worker ready.", flush=True)

    params = pika.URLParameters(RABBITMQ_URL)
    connection = pika.BlockingConnection(params)
    channel = connection.channel()

    channel.queue_declare(queue=STT_JOBS_QUEUE, durable=True)
    channel.basic_qos(prefetch_count=STT_PREFETCH)

    channel.basic_consume(
        queue=STT_JOBS_QUEUE,
        on_message_callback=handle_message,
        auto_ack=False,
    )

    print(f"Consuming queue={STT_JOBS_QUEUE} prefetch={STT_PREFETCH}", flush=True)
    channel.start_consuming()


def handle_message(channel: Any, method: Any, properties: Any, body: bytes) -> None:
    started_at = time.perf_counter()
    reply_to = properties.reply_to
    correlation_id = properties.correlation_id

    if not reply_to or not correlation_id:
        print("Rejecting STT job without reply_to/correlation_id", flush=True)
        channel.basic_reject(delivery_tag=method.delivery_tag, requeue=False)
        return

    temp_path = f"/tmp/voiceai-stt-{correlation_id}.wav"

    try:
        with open(temp_path, "wb") as f:
            f.write(body)

        text = runtime.transcribe_file(temp_path)

        response = {
            "stage": "stt",
            "text": text,
            "computeMs": round((time.perf_counter() - started_at) * 1000, 1),
        }

        channel.basic_publish(
            exchange="",
            routing_key=reply_to,
            properties=pika.BasicProperties(
                correlation_id=correlation_id,
                content_type="application/json",
            ),
            body=json.dumps(response).encode("utf-8"),
        )

        channel.basic_ack(delivery_tag=method.delivery_tag)

    except Exception as error:
        error_response = {
            "stage": "stt",
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

    finally:
        try:
            os.remove(temp_path)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)