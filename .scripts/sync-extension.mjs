#!/usr/bin/env bun
// Keep the repo copy and the installed OMP extension in sync.
//   bun .scripts/sync-extension.mjs --diff       show drift (default)
//   bun .scripts/sync-extension.mjs --to-live    repo → installed copy
//   bun .scripts/sync-extension.mjs --from-live  installed copy → repo
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REPO_FILE = new URL('../extension/headroom.ts', import.meta.url).pathname;
const LIVE_FILE = join(process.env.OMP_AGENT_DIR || join(homedir(), '.omp', 'agent'), 'extensions', 'headroom.ts');
const mode = process.argv[2] || '--diff';

if (!existsSync(LIVE_FILE)) {
    console.error(`no installed extension at ${LIVE_FILE}`);
    process.exit(1);
}

if (mode === '--to-live') {
    copyFileSync(REPO_FILE, LIVE_FILE);
    console.log(`repo → live: ${LIVE_FILE}`);
} else if (mode === '--from-live') {
    copyFileSync(LIVE_FILE, REPO_FILE);
    console.log(`live → repo: ${REPO_FILE} (re-run scan-leaks before committing!)`);
} else {
    const diff = spawnSync('diff', ['-u', LIVE_FILE, REPO_FILE], { encoding: 'utf8' });
    if (diff.status === 0) {
        console.log('in sync');
    } else {
        console.log(diff.stdout);
        process.exit(1);
    }
}
