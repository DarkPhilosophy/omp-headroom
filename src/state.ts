// Cross-session subagent stats via filesystem IPC and process-shared counters.
//
// loadLegacyPiModule imports each extension with `?mtime=<now>`, which busts
// Bun's module cache — so every session (main + each subagent) gets a SEPARATE
// factory call. Module-level state in THIS module IS shared across those calls
// (Bun caches the module despite the ?mtime bust), so it is the only reliable
// cross-call bridge. Each subagent instance also writes its running totals to a
// per-instance JSON file; the main UI session reads + sums them to render `(+N)`.
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VENV_DIR } from "./config.ts";
import type { HeadroomState } from "./types.ts";
import { asNumber } from "./util.ts";

export const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
export const FOREIGN_DIR = join(dirname(VENV_DIR), "headroom-foreign", String(process.pid));
export const FOREIGN_FILE = join(FOREIGN_DIR, `${INSTANCE_ID}.json`);
export const FOREIGN_TTL_MS = Number(process.env.OMP_HEADROOM_FOREIGN_TTL_MS || 6 * 3_600_000);

// SHARED across all factory calls (main + subagent). The factory creates a
// SEPARATE `state` object per call, so per-state fields cannot bridge them;
// these module-level counters are the ONLY reliable cross-call channel. Held in
// one mutable object because ES module bindings cannot be reassigned by importers.
export const shared = {
  foreignProvider: 0,
  foreignTool: 0,
  foreignCcr: 0,
  foreignCleared: false,
};

// Session IDs of subagents seen in THIS process (hasUI=false session_start).
// The main reads the proxy's per_project bucket for each to render (+N).
export const subagentSessionIds = new Set<string>();

interface ForeignSelfState {
  foreignSelfProvider?: number;
  foreignSelfTool?: number;
  foreignSelfCcr?: number;
}

// Called by a subagent/advisor instance after it compresses. Writes this
// instance's cumulative foreign totals to its own file (overwrite, not append,
// so files stay tiny and concurrent writers never contend on one file).
export function writeForeignSelf(state: ForeignSelfState): void {
  try {
    mkdirSync(FOREIGN_DIR, { recursive: true });
    writeFileSync(
      FOREIGN_FILE,
      JSON.stringify({
        provider: Math.max(0, asNumber(state.foreignSelfProvider)),
        tool: Math.max(0, asNumber(state.foreignSelfTool)),
        ccr: Math.max(0, asNumber(state.foreignSelfCcr)),
        ts: Date.now(),
      }),
    );
  } catch {
    // Best effort: never break a hook on IPC failure.
  }
}

export function readForeignTotals(): { provider: number; tool: number; ccr: number } {
  const totals = { provider: 0, tool: 0, ccr: 0 };
  let files: string[];
  try {
    files = readdirSync(FOREIGN_DIR);
  } catch {
    return totals;
  }
  const now = Date.now();
  for (const name of files) {
    if (!name.endsWith(".json") || name === `${INSTANCE_ID}.json`) continue;
    const file = join(FOREIGN_DIR, name);
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (now - asNumber(data?.ts) > FOREIGN_TTL_MS) {
        try {
          unlinkSync(file);
        } catch {}
        continue;
      }
      totals.provider += Math.max(0, asNumber(data?.provider));
      totals.tool += Math.max(0, asNumber(data?.tool));
      totals.ccr += Math.max(0, asNumber(data?.ccr));
    } catch {
      // Ignore unreadable/half-written files.
    }
  }
  return totals;
}

// Called by the main UI session at session_start: wipe stale foreign files so
// each fresh main session starts its `(+N)` aggregation clean.
export function clearForeignFiles(): void {
  let files: string[];
  try {
    files = readdirSync(FOREIGN_DIR);
  } catch {
    return;
  }
  for (const name of files) {
    try {
      unlinkSync(join(FOREIGN_DIR, name));
    } catch {}
  }
}

// Per-factory-call mutable state. Each OMP session (main + subagent) gets its
// own instance; cross-call totals live in the module-level `shared` object above.
export function createHeadroomState(): HeadroomState {
  return {
    enabled: process.env.OMP_HEADROOM_DISABLED !== "1",
    proxyReady: false,
    proxyStarting: false,
    proxyProcess: undefined,
    proxyCheckedAt: 0,
    statsFetchedAt: 0,
    statsInFlight: undefined,
    stats: undefined,
    lastError: "",
    installState: "",
    version: "",
    latest: "",
    reconcileKey: "",
    providerCompressions: 0,
    toolCompressions: 0,
    ccrHashes: 0,
    tokensSaved: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    cacheInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessionArchiveCompactions: 0,
    ompCompactions: 0,
    _ompHydrated: false,
    _archiveHydrated: false,
    sessionArchiveCharsBefore: 0,
    sessionArchiveCharsAfter: 0,
    sessionArchiveCharsSaved: 0,
    headroomCompactActive: false,
    lastCompactionCcrHash: "",
    foreignProvider: 0,
    foreignTool: 0,
    foreignCcr: 0,
    foreignReadAt: 0,
    foreignSelfProvider: 0,
    foreignSelfTool: 0,
    foreignSelfCcr: 0,
    foreignCleared: false,
    sessionId: "",
    rainbowPhase: 0,
  };
}
