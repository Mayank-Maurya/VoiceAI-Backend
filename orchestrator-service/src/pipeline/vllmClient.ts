import {
    LLM_MAX_NEW_TOKENS,
    LLM_SYSTEM_PROMPT,
    LLM_TEMPERATURE,
    VLLM_BASE_URL,
    VLLM_MODEL_ID,
} from "../config";

export async function generateLlmResponse(userText: string): Promise<string> {
    const response = await fetch(`${VLLM_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: VLLM_MODEL_ID,
            messages: [
                { role: "system", content: LLM_SYSTEM_PROMPT },
                { role: "user", content: userText },
            ],
            max_tokens: LLM_MAX_NEW_TOKENS,
            temperature: LLM_TEMPERATURE,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`vLLM request failed: ${response.status} ${body}`);
    }

    const json = await response.json() as {
        choices?: Array<{
            message?: {
                content?: string;
            };
        }>;
    };

    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) {
        throw new Error("vLLM returned an empty response");
    }

    return text;
}