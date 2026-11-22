// Real per-session pricing. OMP bills each assistant turn at the model's real
// rate (pi-catalog `Usage.cost`, in dollars) — unlike the proxy's `$` figures,
// which are list-price estimates that fall back to a flat $3/1M for models
// LiteLLM cannot resolve (e.g. glm-5.3-flash, real rate $0.15/1M — ~20x off).
// These helpers accumulate the real billed dollars per session and re-price
// compression savings at the session's own blended input rate (cache mix
// included), so the widget shows what this session actually costs.
import type { HeadroomState } from "./types.ts";
import { asNumber, isRecord } from "./util.ts";

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
  const input = Math.max(0, asNumber(usage.input));
  const cacheRead = Math.max(0, asNumber(usage.cacheRead));
  const cacheWrite = Math.max(0, asNumber(usage.cacheWrite));
  state.realInputTokens += input + cacheRead + cacheWrite;
  state.realInputUsd +=
    Math.max(0, asNumber(cost.input)) +
    Math.max(0, asNumber(cost.cacheRead)) +
    Math.max(0, asNumber(cost.cacheWrite));
}

/** Re-price one compression's saved input tokens at the session's blended rate. */
export function applyRealSavings(state: HeadroomState, tokensSaved: unknown): void {
  const saved = Math.max(0, asNumber(tokensSaved));
  const rate = realInputRate(state.realInputTokens, state.realInputUsd);
  if (rate > 0) state.realSavedUsd += saved * rate;
}
