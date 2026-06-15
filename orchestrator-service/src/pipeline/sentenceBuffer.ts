// accumulates streaming LLM token and yields complete sentences
// sentence boundaries: ".", "?", "!" or "\n"
// max char 150+

const SENTENCE_ENDERS = /[.?!]\s/;
const MAX_BUFFER_CHARS = 150;

export async function* sentenceBuffer(
    tokens: AsyncIterable<string>
): AsyncGenerator<string> {
    let buffer = "";

    for await (const token of tokens) {
        buffer += token;

        while(true) {
            const match  = SENTENCE_ENDERS.exec(buffer);

            if (match) {
                const sentence = buffer.slice(0, match.index + 1).trim();
                buffer = buffer.slice(match.index + match[0].length);

                if (sentence) {
                    yield sentence;
                }
                continue;
            }

            // No sentence ender found. Check for overflow flush.
            if (buffer.length >= MAX_BUFFER_CHARS) {
                // Flush at the last space to avoid cutting mid-word.
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