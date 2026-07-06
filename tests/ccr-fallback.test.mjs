import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCcrFallback } from '../extension/headroom.ts';

const tempRoots = [];

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('readCcrFallback', () => {
    test('reads non-empty local archives and ignores missing or empty files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'omp-headroom-ccr-'));
        tempRoots.push(root);
        const ccrDir = join(root, 'headroom-ccr');
        const original = 'archived CCR content\n';

        await mkdir(ccrDir, { recursive: true });
        await writeFile(join(ccrDir, 'abc123.txt'), original, 'utf8');
        await writeFile(join(ccrDir, 'empty.txt'), '', 'utf8');

        expect(await readCcrFallback('abc123', ccrDir)).toBe(original);
        expect(await readCcrFallback('missing', ccrDir)).toBeUndefined();
        expect(await readCcrFallback('empty', ccrDir)).toBeUndefined();
    });
});
