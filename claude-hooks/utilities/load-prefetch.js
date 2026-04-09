#!/usr/bin/env node
/**
 * load-prefetch.js — /load bypass script
 * Queries Memory HTTP API + Notion API + local plans in parallel,
 * summarizes long Notion pages via Ollama, outputs compact JSON.
 *
 * Usage: node load-prefetch.js <subject> [tags...]
 * Output: JSON to stdout, errors to stderr
 */

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const path = require('path');
const { ollamaChat } = require('./ollama-client');

// ── Config ────────────────────────────────────────────────────────────────────
const MEMORY_BASE = 'http://127.0.0.1:4242';
const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_TASKS_DB = '68d1e0ee-a70a-4a27-b723-dde6ad636904';
const PLANS_SYMLINK = path.join(process.env.HOME, '.claude/plans');
const PLANS_DIR = (() => {
    try { return require('fs').realpathSync(PLANS_SYMLINK); }
    catch { return PLANS_SYMLINK; }
})();
const NOTION_TOKEN = process.env.NOTION_API_TOKEN || process.env.NOTION_TOKEN || process.env.NOTION_API_KEY || '';
const OLLAMA_SUMMARIZE_THRESHOLD = 500; // chars — skip Ollama if page already short
const NOTION_PAGE_CAP = 2; // max pages to fetch full content for

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpPost(urlStr, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;
        const payload = JSON.stringify(body);

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                ...headers
            }
        };

        const req = lib.request(options, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        });
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function httpGet(urlStr, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'GET',
            headers
        };

        const req = lib.request(options, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        });
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
        req.end();
    });
}

// ── Memory search ─────────────────────────────────────────────────────────────
async function searchMemory(subject) {
    const [semantic, tagged] = await Promise.allSettled([
        httpPost(`${MEMORY_BASE}/api/search`, { query: subject, limit: 8 }),
        httpPost(`${MEMORY_BASE}/api/search/by-tag`, { tags: subject.split(/\s+/), limit: 6 })
    ]);

    const seen = new Set();
    const results = [];

    for (const res of [semantic, tagged]) {
        if (res.status !== 'fulfilled') continue;
        for (const item of (res.value.results || [])) {
            const m = item.memory || item;
            const hash = m.content_hash || m.hash;
            if (hash && seen.has(hash)) continue;
            if (hash) seen.add(hash);
            results.push({
                source: 'memory',
                content: m.content || '',
                hash,
                tags: m.tags || [],
                score: item.score || item.relevance_score || 0
            });
        }
    }

    return results;
}

// ── Plans grep ────────────────────────────────────────────────────────────────
function searchPlans(subject) {
    try {
        const escaped = subject.replace(/['"\\]/g, '\\$&');
        const out = execSync(
            `grep -ril "${escaped}" "${PLANS_DIR}" 2>/dev/null || true`,
            { encoding: 'utf-8', timeout: 3000 }
        );
        const files = out.trim().split('\n').filter(Boolean).slice(0, 5);

        return files.map((f) => {
            try {
                const raw = require('fs').readFileSync(f, 'utf-8');
                // Extract TL;DR + Key Card + Actions only (first 60 lines)
                const excerpt = raw.split('\n').slice(0, 60).join('\n');
                return {
                    source: 'plan',
                    file: f,
                    content: excerpt,
                    hash: null
                };
            } catch {
                return null;
            }
        }).filter(Boolean);
    } catch {
        return [];
    }
}

// ── Notion helpers ────────────────────────────────────────────────────────────
function notionHeaders() {
    return {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
    };
}

function extractNotionText(blocks) {
    const lines = [];
    for (const block of blocks || []) {
        const type = block.type;
        const rich = block[type]?.rich_text || [];
        const text = rich.map((r) => r.plain_text || '').join('');
        if (text.trim()) lines.push(text.trim());
    }
    return lines.join('\n');
}

async function fetchNotionPageContent(pageId) {
    try {
        const data = await httpGet(
            `${NOTION_BASE}/blocks/${pageId}/children?page_size=50`,
            notionHeaders()
        );
        return extractNotionText(data.results || []);
    } catch {
        return '';
    }
}

async function searchNotion(subject) {
    if (!NOTION_TOKEN) return [];

    try {
        // Query Tasks DB
        const db = await httpPost(
            `${NOTION_BASE}/databases/${NOTION_TASKS_DB}/query`,
            {
                filter: {
                    property: 'title',
                    title: { contains: subject }
                },
                page_size: 10
            },
            notionHeaders()
        );

        const pages = (db.results || []).slice(0, NOTION_PAGE_CAP);
        const results = [];

        for (const page of pages) {
            const titleProp = Object.values(page.properties || {}).find(
                (p) => p.type === 'title'
            );
            const title = titleProp?.title?.map((r) => r.plain_text).join('') || 'Untitled';
            const pageId = page.id;

            let content = await fetchNotionPageContent(pageId);

            // Summarize via Ollama if content is long
            if (content.length > OLLAMA_SUMMARIZE_THRESHOLD) {
                try {
                    const summary = await ollamaChat([
                        {
                            role: 'user',
                            content: `Résume cette page Notion en 3 bullet points max, en français, de façon télégraphique:\n\n${content.slice(0, 3000)}`
                        }
                    ], { timeoutMs: 15000 });
                    // Strip think blocks from qwen3
                    content = summary.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                } catch {
                    // Keep raw content if Ollama fails (truncated)
                    content = content.slice(0, 500) + '…';
                }
            }

            results.push({
                source: 'notion',
                title,
                pageId,
                url: page.url || '',
                content,
                hash: null
            });
        }

        return results;
    } catch (e) {
        process.stderr.write(`[load-prefetch] Notion error: ${e.message}\n`);
        return [];
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const subject = process.argv.slice(2).join(' ').trim();
    if (!subject) {
        process.stderr.write('Usage: node load-prefetch.js <subject>\n');
        process.exit(1);
    }

    const [memResults, planResults, notionResults] = await Promise.allSettled([
        searchMemory(subject),
        Promise.resolve(searchPlans(subject)),
        searchNotion(subject)
    ]);

    const output = {
        subject,
        sources: {
            memory: memResults.status === 'fulfilled' ? memResults.value : [],
            plans: planResults.status === 'fulfilled' ? planResults.value : [],
            notion: notionResults.status === 'fulfilled' ? notionResults.value : []
        },
        errors: [
            memResults.status === 'rejected' ? `memory: ${memResults.reason?.message}` : null,
            planResults.status === 'rejected' ? `plans: ${planResults.reason?.message}` : null,
            notionResults.status === 'rejected' ? `notion: ${notionResults.reason?.message}` : null
        ].filter(Boolean),
        generated_at: new Date().toISOString()
    };

    process.stdout.write(JSON.stringify(output));
}

main().catch((e) => {
    process.stderr.write(`[load-prefetch] Fatal: ${e.message}\n`);
    process.exit(1);
});
