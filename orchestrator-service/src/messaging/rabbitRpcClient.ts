import crypto from "node:crypto";
import * as amqp from "amqplib";
import type { Channel, ConsumeMessage } from "amqplib";
import {
    ORCHESTRATOR_REPLY_QUEUE,
    RABBITMQ_URL,
    STAGE_TIMEOUT_MS,
} from "../config";

type PendingRequest = {
    resolve: (value: Buffer) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
};

type RabbitConnection = Awaited<ReturnType<typeof amqp.connect>>;

export class RabbitRpcClient {
    private connection: RabbitConnection | null = null;
    private channel: Channel | null = null;
    private pending = new Map<string, PendingRequest>();

    async connect(): Promise<void> {
        this.connection = await amqp.connect(RABBITMQ_URL);
        this.channel = await this.connection.createChannel();

        await this.channel.assertQueue(ORCHESTRATOR_REPLY_QUEUE, {
            durable: false,
            exclusive: true,
            autoDelete: true,
        });

        await this.channel.consume(
            ORCHESTRATOR_REPLY_QUEUE,
            (message) => this.handleReply(message),
            { noAck: false }
        );

        console.log(`RabbitMQ connected. Reply queue=${ORCHESTRATOR_REPLY_QUEUE}`);
    }

    async request(
        queue: string,
        body: Buffer,
        options: {
            timeoutMs?: number;
            contentType?: string;
            headers?: Record<string, unknown>;
        } = {}
    ): Promise<Buffer> {
        if (!this.channel) {
            throw new Error("RabbitRpcClient is not connected");
        }

        const correlationId = crypto.randomUUID();
        const timeoutMs = options.timeoutMs ?? STAGE_TIMEOUT_MS;

        await this.channel.assertQueue(queue, {
            durable: true,
            autoDelete: false,
        });

        return new Promise<Buffer>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(correlationId);
                reject(new Error(`RabbitMQ request timed out: queue=${queue}`));
            }, timeoutMs);

            this.pending.set(correlationId, { resolve, reject, timeout });

            this.channel!.sendToQueue(queue, body, {
                correlationId,
                replyTo: ORCHESTRATOR_REPLY_QUEUE,
                contentType: options.contentType ?? "application/octet-stream",
                expiration: String(timeoutMs),
                headers: options.headers,
            });
        });
    }

    async close(): Promise<void> {
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("RabbitMQ client closed"));
            this.pending.delete(id);
        }

        await this.channel?.close();
        await this.connection?.close();
    }

    private handleReply(message: ConsumeMessage | null): void {
        if (!message || !this.channel) {
            return;
        }

        const correlationId = message.properties.correlationId;
        const pending = correlationId ? this.pending.get(correlationId) : undefined;

        if (!pending) {
            this.channel.ack(message);
            return;
        }

        clearTimeout(pending.timeout);
        this.pending.delete(correlationId);

        pending.resolve(message.content);
        this.channel.ack(message);
    }
}

export const rabbitRpcClient = new RabbitRpcClient();