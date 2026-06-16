import {
    LLM_MAX_NEW_TOKENS,
    LLM_SYSTEM_PROMPT,
    LLM_TEMPERATURE,
    VLLM_BASE_URL,
    VLLM_MODEL_ID,
} from "../config";
import type { ChatMessage } from "../types/session";

export async function* streamLlmResponse(
    messages: ChatMessage[],
    signal?: AbortSignal,
): AsyncGenerator<string> {
    const response = await fetch(`${VLLM_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: VLLM_MODEL_ID,
            messages,
            max_tokens: LLM_MAX_NEW_TOKENS,
            temperature: LLM_TEMPERATURE,
            stream: true,
        }),
        signal: signal ?? null,
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`vLLM stream request failed: ${response.status} ${body}`);
    }

    if (!response.body) {
        throw new Error("vLLM returned no response body for streaming");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            // keeping last line in buffer
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                const trimmed = line.trim();

                if (!trimmed || trimmed.startsWith(":")) continue;

                if (!trimmed.startsWith("data:")) continue;

                const payload = trimmed.slice("data:".length).trim();

                if (payload === "[DONE]") return;

                try {
                    const parsed = JSON.parse(payload) as {
                        choices?: Array<{
                            delta?: { content?: string }
                        }>;
                    };

                    const token = parsed.choices?.[0]?.delta?.content;
                    if (token) {
                        yield token;
                    }
                } catch {
                    // skip unwanted chunk.
                }
            }
        }

    } finally {
        reader.releaseLock();
    }
}