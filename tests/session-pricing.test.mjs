import { describe, expect, test } from "bun:test";
import { applyRealSavings, applyRealUsage, realInputRate } from "../src/session-pricing.ts";
import { createHeadroomState } from "../src/state.ts";

describe("real session pricing", () => {
  test("blended input rate weights cache mix and zeroes on missing data", () => {
    expect(realInputRate(1_000_000, 1.5)).toBeCloseTo(1.5e-6);
    expect(realInputRate(0, 1.5)).toBe(0);
    expect(realInputRate(1000, 0)).toBe(0);
    expect(realInputRate(undefined, undefined)).toBe(0);
    expect(realInputRate(-5, -5)).toBe(0);
  });

  test("applyRealUsage accumulates billed dollars and input-side tokens", () => {
    const state = createHeadroomState();
    applyRealUsage(state, {
      input: 100,
      output: 50,
      cacheRead: 900,
      cacheWrite: 10,
      cost: { input: 0.01, output: 0.03, cacheRead: 0.005, cacheWrite: 0.002, total: 0.047 },
    });
    applyRealUsage(state, {
      input: 200,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0.02, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    });
    expect(state.realCostUsd).toBeCloseTo(0.077);
    // input-side = input + cacheRead + cacheWrite, both turns
    expect(state.realInputTokens).toBe(100 + 900 + 10 + 200);
    expect(state.realInputUsd).toBeCloseTo(0.01 + 0.005 + 0.002 + 0.02);
  });

  test("applyRealUsage tolerates missing cost or malformed usage", () => {
    const state = createHeadroomState();
    applyRealUsage(state, undefined);
    applyRealUsage(state, { input: 10 });
    applyRealUsage(state, { input: 10, cost: "garbage" });
    expect(state.realCostUsd).toBe(0);
    expect(state.realInputTokens).toBe(20);
    expect(state.realInputUsd).toBe(0);
  });

  test("compression savings re-price at the session's blended rate", () => {
    const state = createHeadroomState();
    // Before any billed turn: rate unknown, nothing accumulated.
    applyRealSavings(state, 10_000);
    expect(state.realSavedUsd).toBe(0);
    // One turn with 1M input-side tokens billed at $0.20 blended.
    applyRealUsage(state, {
      input: 100_000,
      cacheRead: 900_000,
      cacheWrite: 0,
      output: 0,
      cost: { input: 0.02, cacheRead: 0.18, cacheWrite: 0, output: 0, total: 0.2 },
    });
    applyRealSavings(state, 10_000);
    // 10k tokens × $0.20/1M = $0.002 — not the proxy's $3/1M flat ($0.03).
    expect(state.realSavedUsd).toBeCloseTo(0.002);
  });
});
