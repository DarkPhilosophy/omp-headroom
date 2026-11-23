// Real per-session pricing. The proxy's `$` figures are list-price estimates
// baked with a flat $3/1M fallback for models LiteLLM cannot resolve (e.g.
// glm-5.3-flash, real rate $0.15/1M input / $0.03/1M cache-read — ~20-100x
// off). OMP has the real rates (its model registry bills `usage.cost` per
// turn, and caches the full catalog in ~/.omp/agent/models.db), so this
// module re-derives every dollar the widget shows:
//   - session billed $: summed from the session transcript's usage.cost
//   - session saved $: proxy's exact tokens_saved × real cache-read rate
//   - lifetime $: savings ledger re-priced per event at the model's real rate
// The proxy's own dollar fields are never displayed.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HeadroomState } from "./types.ts";
import { asNumber, isRecord } from "./util.ts";

export const SAVINGS_LEDGER_PATH = join(homedir(), ".headroom", "savings_events.jsonl");
export const MODELS_DB_PATH = join(homedir(), ".omp", "agent", "models.db");

/**
 * Blended real input $/token for the session: what a marginal prompt token
 * actually cost here, weighting input/cache-read/cache-write rates by this
 * session's own cache mix. 0 when no billed usage has been observed yet.
 */
export function realInputRate(tokens: unknown, usd: unknown): number {
  const t = Math.max(0, asNumber(tokens));
  const u = Math.max(0, asNumber(usd));
  return t > 0 && u > 0 ? u / t : 0;
}

/** Accumulate one assistant turn's real billed usage (from `message_end`). */
export function applyRealUsage(state: HeadroomState, usage: unknown): void {
  if (!isRecord(usage)) return;
  const cost = isRecord(usage.cost) ? usage.cost : {};
  state.realCostUsd += Math.max(0, asNumber(cost.total));
  state.realInputTokens +=
    Math.max(0, asNumber(usage.input)) +
    Math.max(0, asNumber(usage.cacheRead)) +
    Math.max(0, asNumber(usage.cacheWrite));
  state.realInputUsd +=
    Math.max(0, asNumber(cost.input)) +
    Math.max(0, asNumber(cost.cacheRead)) +
    Math.max(0, asNumber(cost.cacheWrite));
}

/**
 * Real input rate for the CURRENT session's model (per token), captured from
 * ctx.model.cost — the same rates OMP bills with. Falls back to the session's
 * own blended rate; 0 when neither is known.
 */
export function sessionInputRate(state: HeadroomState): number {
  if (state.sessionCacheReadRate > 0) return state.sessionCacheReadRate;
  return realInputRate(state.realInputTokens, state.realInputUsd);
}

/**
 * Sum one session transcript file's real billed usage into the state, so a
 * resumed/restarted session shows its full-history real cost instead of
 * rebuilding from zero. Tolerant of partial/corrupt lines.
 */
export async function hydrateRealUsageFromTranscript(
  state: HeadroomState,
  sessionFile: unknown,
): Promise<void> {
  if (typeof sessionFile !== "string" || !sessionFile) return;
  let text: string;
  try {
    text = await readFile(sessionFile, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const message =
      isRecord(obj) && isRecord(obj.message) ? obj.message : isRecord(obj) ? obj : undefined;
    if (isRecord(message) && message.role === "assistant") applyRealUsage(state, message.usage);
  }
}

// ── Model rate lookup (omp's live model cache) ───────────────────────────────

type RateKind = "input" | "cacheRead" | "output";

const rateCache = new Map<string, number | undefined>();
const modelsDbs = new Map<string, Database>();

function modelEntries(parsed: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(parsed) ? parsed : isRecord(parsed) ? Object.values(parsed) : [];
  const entries: Array<Record<string, unknown>> = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    if (isRecord(value.models)) {
      // Payload wrapper: { models: { id: spec } } or { models: [spec] }
      entries.push(...modelEntries(value.models));
    } else if (typeof value.id === "string") {
      entries.push(value);
    } else {
      // Map keyed by id: { "model-id": spec }
      for (const inner of Object.values(value)) {
        if (isRecord(inner) && typeof inner.id === "string") entries.push(inner);
      }
    }
  }
  return entries;
}

/**
 * Real rate in $/token for a model id, read from omp's live model cache —
 * the same catalog OMP bills `usage.cost` from. Rate kinds are per-token
 * dollars; the cache rows carry per-1M figures. Undefined when unknown.
 */
export function modelRatePerToken(
  model: string,
  kind: RateKind = "cacheRead",
  dbPath: string = MODELS_DB_PATH,
): number | undefined {
  const key = `${model}|${kind}|${dbPath}`;
  if (rateCache.has(key)) return rateCache.get(key);
  let result: number | undefined;
  try {
    let db = modelsDbs.get(dbPath);
    if (!db) {
      db = new Database(dbPath, { readonly: true });
      modelsDbs.set(dbPath, db);
    }
    const rows = db
      .query("SELECT models FROM model_cache ORDER BY updated_at")
      .all() as Array<{ models: string }>;
    for (const row of rows) {
      for (const entry of modelEntries(JSON.parse(row.models))) {
        if (entry.id === model && isRecord(entry.cost)) {
          const rate = asNumber(entry.cost[kind]);
          if (rate > 0) result = rate / 1_000_000;
        }
      }
    }
  } catch {
    result = undefined;
  }
  rateCache.set(key, result);
  return result;
}

// ── Lifetime ledger re-derivation ────────────────────────────────────────────

export interface LedgerTotals {
  /** Saved tokens, summed. */
  tokens: number;
  /** Saved tokens re-priced at each event model's real cache-read rate. */
  usd: number;
  /** Events whose model had no known rate (excluded from `usd`). */
  unpricedEvents: number;
}

const ledgerCache = new Map<string, { totals: LedgerTotals; at: number }>();
const LEDGER_CACHE_MS = 60_000;

/**
 * Lifetime savings re-derived from the durable ledger at real rates — the
 * proxy's own lifetime $ bakes the flat fallback rate and never recomputes.
 * Saved tokens are stable prefix content, so they are priced at the model's
 * cache-read rate (what that content would actually have billed).
 */
export function realLedgerTotals(
  ledgerPath: string = SAVINGS_LEDGER_PATH,
  modelsDbPath: string = MODELS_DB_PATH,
): LedgerTotals {
  const cached = ledgerCache.get(`${ledgerPath}|${modelsDbPath}`);
  if (cached && Date.now() - cached.at < LEDGER_CACHE_MS) return cached.totals;
  let tokens = 0;
  let usd = 0;
  let unpricedEvents = 0;
  try {
    const content = readFileSync(ledgerPath, "utf8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(event)) continue;
      const saved = Math.max(0, asNumber(event.saved));
      if (saved <= 0) continue;
      tokens += saved;
      const rate = modelRatePerToken(String(event.model ?? ""), "cacheRead", modelsDbPath);
      if (rate === undefined) {
        unpricedEvents += 1;
        continue;
      }
      usd += saved * rate;
    }
  } catch {
    // Missing/unreadable ledger → zero totals, not a crash.
  }
  const totals: LedgerTotals = { tokens, usd, unpricedEvents };
  ledgerCache.set(`${ledgerPath}|${modelsDbPath}`, { totals, at: Date.now() });
  return totals;
}
