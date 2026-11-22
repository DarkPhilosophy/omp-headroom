// Subagent (+N) stats via process-shared counters.
//
// loadLegacyPiModule imports each extension with `?mtime=<now>`, which busts
// Bun's module cache — so every session (main + each subagent) gets a SEPARATE
// factory call. Module-level state in THIS module IS shared across those calls
// (Bun caches the module despite the ?mtime bust), so it is the only reliable
// cross-call bridge. Subagents are in-process in OMP, so the shared counters
// are sufficient: earlier versions additionally mirrored totals through
// per-instance JSON files, but no writer was ever wired up, so that path was
// dead and has been removed.
import type { HeadroomState } from "./types.ts";

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
    realCostUsd: 0,
    realInputTokens: 0,
    realInputUsd: 0,
    realSavedUsd: 0,
    sessionId: "",
    rainbowPhase: 0,
    connectAttempt: 0,
    connectExhausted: false,
  };
}
