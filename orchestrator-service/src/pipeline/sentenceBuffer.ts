/**
 * Accumulates streaming LLM tokens and yields complete sentences.
 *
 * Split rules:
 *   1. Sentence-ending punctuation followed by a space: ". ", "? ", "! "
 *      BUT only when the period/etc is NOT inside quotes (avoids splitting
 *      on things like: He said "hello." Then he left.)
 *   2. Newlines always split.
 *   3. Safety overflow at 400 chars — flush at the last comma+space or space.
 */

const SENTENCE_END = /[.?!]\s/g;
const MAX_BUFFER_CHARS = 400;

export async function* sentenceBuffer(
    tokens: AsyncIterable<string>
): AsyncGenerator<string> {
    let buffer = "";

    for await (const token of tokens) {
        buffer += token;

        // Split on newlines first.
        while (buffer.includes("\n")) {
            const nlIdx = buffer.indexOf("\n");
            const chunk = buffer.slice(0, nlIdx).trim();
            buffer = buffer.slice(nlIdx + 1);
            if (chunk) {
                yield chunk;
            }
        }

        while (true) {
            const splitIdx = findSentenceEnd(buffer);

            if (splitIdx >= 0) {
                const sentence = buffer.slice(0, splitIdx + 1).trim();
                buffer = buffer.slice(splitIdx + 1).trimStart();

                if (sentence) {
                    yield sentence;
                }
                continue;
            }

            // No sentence ender found. Check for overflow flush.
            if (buffer.length >= MAX_BUFFER_CHARS) {
                // Prefer splitting at ", " for natural pause.
                const commaIdx = buffer.lastIndexOf(", ");
                if (commaIdx > 0) {
                    const chunk = buffer.slice(0, commaIdx + 1).trim();
                    buffer = buffer.slice(commaIdx + 2);
                    if (chunk) {
                        yield chunk;
                    }
                    continue;
                }

                // Fall back to last space.
                const lastSpace = buffer.lastIndexOf(" ");
                if (lastSpace > 0) {
                    const chunk = buffer.slice(0, lastSpace).trim();
                    buffer = buffer.slice(lastSpace + 1);
                    if (chunk) {
                        yield chunk;
                    }
                    continue;
                }
            }

            break;
        }
    }

    const remaining = buffer.trim();
    if (remaining) {
        yield remaining;
    }
}

/**
 * Find the index of the punctuation char (. ? !) at a real sentence boundary.
 * Skips periods inside quotes by counting quote parity.
 * Returns the index of the punctuation char, or -1.
 */
function findSentenceEnd(text: string): number {
    let inQuote = false;

    for (let i = 0; i < text.length - 1; i++) {
        const ch = text[i];

        if (ch === '"' || ch === '“' || ch === '”') {
            inQuote = !inQuote;
            continue;
        }

        if (!inQuote && (ch === '.' || ch === '?' || ch === '!')) {
            const next = text[i + 1];
            if (next === ' ' || next === '\n') {
                return i;
            }
        }
    }

    return -1;
}