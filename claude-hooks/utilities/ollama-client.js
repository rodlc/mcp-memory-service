/**
 * Ollama HTTP client utility
 * Direct HTTP calls to local Ollama — no dependencies.
 * Default model: gemma3:4b (no think-loop, validated 2026-04-11)
 */

const http = require('http');

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'gemma3:4b';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Send a chat request to Ollama.
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} opts
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.stream] - default false
 * @returns {Promise<string>} assistant message content
 */
function ollamaChat(messages, opts = {}) {
    const {
        model = DEFAULT_MODEL,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        stream = false
    } = opts;

    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ model, messages, stream });
        const url = new URL('/api/chat', OLLAMA_ENDPOINT);

        const options = {
            hostname: url.hostname,
            port: url.port || 11434,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const content = parsed?.message?.content || parsed?.response || '';
                    resolve(content);
                } catch (e) {
                    reject(new Error(`Ollama parse error: ${e.message} — raw: ${data.substring(0, 200)}`));
                }
            });
        });

        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error(`Ollama timeout after ${timeoutMs}ms`));
        });

        req.on('error', (err) => reject(new Error(`Ollama connection error: ${err.message}`)));
        req.write(body);
        req.end();
    });
}

module.exports = { ollamaChat, DEFAULT_MODEL };
