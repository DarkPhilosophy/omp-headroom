import { describe, expect, test } from 'bun:test';

import {
    createResponsesSessionCompaction,
    createSessionCompaction,
    expandSessionArchiveText,
    payloadHasCompressedMarker,
} from '../extension/headroom.ts';

const MARKER = '[Headroom session archive]';
const big = 'context payload '.repeat(4000); // ~64 KB
const opts = { liveMessages: 2, minPrefixChars: 1000, minPrefixShare: 0.2, archiveMaxMessageChars: 900 };

const findArchive = messages => messages.find(m => typeof m.content === 'string' && m.content.includes(MARKER));

describe('createSessionCompaction', () => {
    test('refuses tiny sessions', () => {
        const result = createSessionCompaction([{ role: 'user', content: 'x' }], opts);
        expect(result.compacted).toBe(false);
        expect(result.reason).toBe('too_few_messages');
    });

    test('refuses when the prefix is too small', () => {
        const result = createSessionCompaction(
            [
                { role: 'user', content: 'a' },
                { role: 'assistant', content: 'b' },
                { role: 'user', content: 'c' },
                { role: 'assistant', content: 'd' },
                { role: 'user', content: 'e' },
            ],
            opts,
        );
        expect(result.compacted).toBe(false);
        expect(result.reason).toBe('prefix_too_small');
    });

    test('compacts a stable prefix and keeps head + live tail verbatim', () => {
        const messages = [
            { role: 'system', content: 'rules' },
            { role: 'user', content: big },
            { role: 'assistant', content: big },
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' },
        ];
        const result = createSessionCompaction(messages, opts);
        expect(result.compacted).toBe(true);
        expect(result.messages[0]).toBe(messages[0]);
        expect(result.messages.at(-2)).toBe(messages.at(-2));
        expect(result.messages.at(-1)).toBe(messages.at(-1));
        expect(findArchive(result.messages)?.content).toMatch(/Retrieve more: hash=[0-9a-f]{24}/);
        expect(result.totalChars).toBeGreaterThan(result.prefixChars);
    });

    test('re-compaction folds the previous archive into the new prefix', () => {
        const first = createSessionCompaction(
            [
                { role: 'system', content: 'rules' },
                { role: 'user', content: big },
                { role: 'assistant', content: big },
                { role: 'user', content: 'q' },
                { role: 'assistant', content: 'a' },
            ],
            opts,
        );
        const archive = findArchive(first.messages);
        const second = createSessionCompaction(
            [
                { role: 'system', content: 'rules' },
                archive,
                { role: 'user', content: big },
                { role: 'assistant', content: big },
                { role: 'user', content: 'q9' },
                { role: 'assistant', content: 'a9' },
            ],
            opts,
        );
        expect(second.compacted).toBe(true);
        expect(second.hash).not.toBe(first.hash);
        expect(second.originalText).toContain(first.hash);
        expect(second.messages.filter(m => typeof m.content === 'string' && m.content.includes(MARKER)).length).toBe(1);
    });

    test('refuses while the previous archive still sits in the live tail', () => {
        const first = createSessionCompaction(
            [
                { role: 'system', content: 'rules' },
                { role: 'user', content: big },
                { role: 'assistant', content: big },
                { role: 'user', content: 'q' },
                { role: 'assistant', content: 'a' },
            ],
            opts,
        );
        const archive = findArchive(first.messages);
        const refused = createSessionCompaction(
            [
                { role: 'system', content: 'rules' },
                { role: 'user', content: big },
                { role: 'assistant', content: big },
                archive,
                { role: 'user', content: 'q3' },
            ],
            { ...opts, liveMessages: 3 },
        );
        expect(refused.compacted).toBe(false);
        expect(refused.reason).toBe('existing_archive');
    });
});

describe('createResponsesSessionCompaction', () => {
    test('compacts Responses input and never splits a call/output pair', () => {
        const input = [
            { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'sys' }] },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: big }] },
            { type: 'function_call', call_id: 'c1', name: 't', arguments: '{}' },
            { type: 'function_call_output', call_id: 'c1', output: big },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'latest' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fin' }] },
        ];
        const result = createResponsesSessionCompaction(input, opts);
        expect(result.compacted).toBe(true);
        expect(result.input[0]).toBe(input[0]);
        expect(result.input.at(-1)).toBe(input.at(-1));
        // The archived pair leaves together: no orphan output remains.
        expect(result.input.some(i => i.type === 'function_call_output' && i.call_id === 'c1')).toBe(false);
        expect(result.originalText).toContain('c1');
        // Every function_call left alive keeps its output alive too.
        const liveCalls = result.input.filter(i => i.type === 'function_call').map(i => i.call_id);
        const liveOutputs = new Set(result.input.filter(i => i.type === 'function_call_output').map(i => i.call_id));
        for (const id of liveCalls) expect(liveOutputs.has(id)).toBe(true);
    });
});

describe('expandSessionArchiveText', () => {
    test('inlines referenced archive files so chains survive TTL cleanup', () => {
        const first = createSessionCompaction(
            [
                { role: 'system', content: 'rules' },
                { role: 'user', content: big },
                { role: 'assistant', content: big },
                { role: 'user', content: 'q' },
                { role: 'assistant', content: 'a' },
            ],
            opts,
        );
        const archive = findArchive(first.messages);
        const second = createSessionCompaction(
            [
                { role: 'system', content: 'rules' },
                archive,
                { role: 'user', content: 'newer stable content '.repeat(3000) },
                { role: 'assistant', content: 'ok' },
                { role: 'user', content: 'q9' },
                { role: 'assistant', content: 'a9' },
            ],
            opts,
        );
        const store = { [first.hash]: first.originalText };
        const expanded = expandSessionArchiveText(second.originalText, hash => store[hash] ?? '');
        expect(expanded).toContain(`chained session archive hash=${first.hash}`);
        expect(expanded).toContain('context payload context payload');
    });

    test('degrades to plain originalText when the referenced file is gone', () => {
        expect(expandSessionArchiveText('[]', () => '')).toBe('[]');
        expect(expandSessionArchiveText('not json', () => 'x')).toBe('not json');
    });
});

describe('payloadHasCompressedMarker', () => {
    test('detects markers anywhere in a payload tree', () => {
        expect(payloadHasCompressedMarker({ messages: [{ content: 'Retrieve more: hash=abcdef12' }] })).toBe(true);
        expect(payloadHasCompressedMarker({ messages: [{ content: 'plain' }] })).toBe(false);
    });
});
