import type { ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Shared structural types for the Headroom extension. `HeadroomState` is the
// per-factory-call mutable state object; `HeadroomCtx` is a permissive view of
// the OMP extension/command context surfaces the extension actually touches
// (session, command, and hook contexts expose overlapping subsets).

/** Per-session slice of the proxy `/stats` `savings.per_project` map. */
export interface ProxyProjectStats {
  requests?: number;
  tokens_saved?: number;
  savings_percent?: number;
  compression_pct?: number;
  compression_savings_usd?: number;
  total_input_cost_usd?: number;
}

/** Proxy `/stats` JSON — the subset of the provider-defined shape we read. */
export interface ProxyStats {
  savings?: { per_project?: Record<string, ProxyProjectStats | undefined> };
  persistent_savings?: { lifetime?: { tokens_saved?: number; compression_savings_usd?: number } };
  tokens?: { saved?: number };
  cost?: { savingsUsd?: number };
  summary?: {
    compression?: {
      totalTokensRemoved?: number;
      total_tokens_removed?: number;
      total_tokens_saved_with_cli_filtering?: number;
    };
    cost?: { totalSavedUsd?: number; total_saved_usd?: number };
    mcp?: { compressions?: number; retrievals?: number; tokensRemoved?: number };
  };
}

export interface HeadroomState {
  enabled: boolean;
  proxyReady: boolean;
  proxyStarting: boolean;
  proxyProcess: ChildProcess | undefined;
  proxyCheckedAt: number;
  statsFetchedAt: number;
  statsInFlight: Promise<ProxyStats | undefined> | undefined;
  stats: ProxyStats | undefined;
  lastError: string;
  installState: string;
  version: string;
  latest: string;
  reconcileKey: string;
  providerCompressions: number;
  toolCompressions: number;
  ccrHashes: number;
  tokensSaved: number;
  tokensBefore: number;
  tokensAfter: number;
  cacheInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessionArchiveCompactions: number;
  ompCompactions: number;
  _ompHydrated: boolean;
  _archiveHydrated: boolean;
  sessionArchiveCharsBefore: number;
  sessionArchiveCharsAfter: number;
  sessionArchiveCharsSaved: number;
  headroomCompactActive: boolean;
  lastCompactionCcrHash: string;
  foreignProvider: number;
  foreignTool: number;
  foreignCcr: number;
  foreignReadAt: number;
  foreignSelfProvider: number;
  foreignSelfTool: number;
  foreignSelfCcr: number;
  foreignCleared: boolean;
  sessionId: string;
  rainbowPhase: number;
  _debugReqSeq?: number;
}

export type HeadroomUi = ExtensionContext["ui"];

/** Permissive view of the OMP context surfaces the extension reads. */
export interface HeadroomCtx {
  hasUI?: boolean;
  ui?: HeadroomUi;
  model?: { provider?: string; id?: string };
  models?: { list?: () => unknown[] };
  sessionManager?: {
    getSessionId?: () => string | undefined;
    getBranch?: () => unknown[];
  };
  getContextUsage?: () => { tokens?: number; contextWindow?: number; percent?: number } | undefined;
  newSession?: (options?: unknown) => Promise<{ cancelled?: boolean } | undefined>;
  reload?: () => Promise<void>;
  compact?: ExtensionContext["compact"];
}
