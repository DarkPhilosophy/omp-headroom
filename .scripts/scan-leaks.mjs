#!/usr/bin/env bun
// Pre-publish gate: fail when personal paths, credentials, or tokens leak into
// tracked files. Run via `bun .scripts/scan-leaks.mjs` (CI runs it too).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set([
    '.git',
    'node_modules',
    'venv',
    '__pycache__',
    '.ruff_cache',
    '.pytest_cache',
    '.mypy_cache',
]);
const SKIP_FILES = new Set(['bun.lock', 'package-lock.json']);

const RULES = [
    { name: 'personal home path', pattern: /\/home\/(?!user\b|runner\b)[a-z0-9_-]+/g },
    { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { name: 'github token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
    { name: 'openai-style key', pattern: /sk-[A-Za-z0-9_-]{20,}/g },
    {
        name: 'email address',
        pattern: /[a-z0-9._%+-]+@(?!github\.com|users\.noreply\.github\.com)[a-z0-9.-]+\.[a-z]{2,}/gi,
    },
];

const findings = [];
const walk = dir => {
    for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        const stats = statSync(file);
        if (stats.isDirectory()) {
            if (!SKIP_DIRS.has(name)) walk(file);
            continue;
        }
        if (SKIP_FILES.has(name) || stats.size > 2_000_000) continue;
        let text;
        try {
            text = readFileSync(file, 'utf8');
        } catch {
            continue; // binary
        }
        for (const rule of RULES) {
            for (const match of text.matchAll(rule.pattern)) {
                const line = text.slice(0, match.index).split('\n').length;
                findings.push(`${file.replace(ROOT, '')}:${line} — ${rule.name}: ${match[0].slice(0, 60)}`);
            }
        }
    }
};
walk(ROOT);

if (findings.length > 0) {
    console.error(`scan-leaks: ${findings.length} finding(s)`);
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
}
console.log('scan-leaks: clean');
