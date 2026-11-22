import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRealUsage,
  hydrateRealUsageFromTranscript,
  modelRatePerToken,
  realInputRate,
  realLedgerTotals,
  sessionInputRate,
} from "../src/session-pricing.ts";
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

  test("sessionInputRate prefers the captured ctx rate, falls back to blended", () => {
    const state = createHeadroomState();
    expect(sessionInputRate(state)).toBe(0);
    // Blended fallback: 1M input-side tokens billed $0.20 -> $0.20/1M.
    applyRealUsage(state, {
      input: 100_000,
      cacheRead: 900_000,
      cacheWrite: 0,
      output: 0,
      cost: { input: 0.02, cacheRead: 0.18, cacheWrite: 0, output: 0, total: 0.2 },
    });
    expect(sessionInputRate(state)).toBeCloseTo(0.2e-6);
    // Captured live rate wins.
    state.sessionCacheReadRate = 0.03e-6;
    expect(sessionInputRate(state)).toBeCloseTo(0.03e-6);
  });

  test("modelRatePerToken reads real rates from omp model cache rows", () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-pricing-"));
    try {
      const dbPath = join(root, "models.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE model_cache (provider_id TEXT, updated_at INTEGER, models TEXT)");
      db.run("INSERT INTO model_cache (provider_id, updated_at, models) VALUES (?, ?, ?)", [
        "opencode-zen:test",
        1,
        JSON.stringify([{ id: "other", cost: { input: 9 } }]),
      ]);
      db.run("INSERT INTO model_cache (provider_id, updated_at, models) VALUES (?, ?, ?)", [
        "opencode-zen:test",
        2,
        JSON.stringify([
          {
            id: "glm-5.3-flash",
            cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
          },
        ]),
      ]);
      expect(modelRatePerToken("glm-5.3-flash", "input", dbPath)).toBeCloseTo(0.15e-6);
      expect(modelRatePerToken("glm-5.3-flash", "cacheRead", dbPath)).toBeCloseTo(0.03e-6);
      expect(modelRatePerToken("unknown-model", "cacheRead", dbPath)).toBeUndefined();
      // Nested provider payload shape also resolves.
      db.run("INSERT INTO model_cache (provider_id, updated_at, models) VALUES (?, ?, ?)", [
        "nested:test",
        3,
        JSON.stringify({
          models: { "nested-model": { id: "nested-model", cost: { cacheRead: 1 } } },
        }),
      ]);
      expect(modelRatePerToken("nested-model", "cacheRead", dbPath)).toBeCloseTo(1e-6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("realLedgerTotals re-derives savings at real per-model rates", () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-ledger-"));
    try {
      const dbPath = join(root, "models.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE model_cache (provider_id TEXT, updated_at INTEGER, models TEXT)");
      db.run("INSERT INTO model_cache (provider_id, updated_at, models) VALUES (?, ?, ?)", [
        "p",
        1,
        JSON.stringify([{ id: "glm-5.3-flash", cost: { cacheRead: 0.03 } }]),
      ]);
      const ledgerPath = join(root, "savings_events.jsonl");
      writeFileSync(
        ledgerPath,
        [
          JSON.stringify({ model: "glm-5.3-flash", saved: 1_000_000, cost_usd: 3.0 }),
          JSON.stringify({ model: "glm-5.3-flash", saved: 500, cost_usd: 0.0015 }),
          "not json",
          JSON.stringify({ model: "unpriced-model", saved: 1000 }),
        ].join("\n"),
      );
      const totals = realLedgerTotals(ledgerPath, dbPath);
      // Tokens count every saved event; the unpriced model's tokens are
      // counted but excluded from the dollar total.
      expect(totals.tokens).toBe(1_001_500);
      expect(totals.usd).toBeCloseTo(1_000_000 * 0.03e-6 + 500 * 0.03e-6);
      expect(totals.unpricedEvents).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hydrateRealUsageFromTranscript sums full session history", async () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-hydrate-"));
    try {
      const file = join(root, "session.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({ message: { role: "user", content: "hi" } }),
          JSON.stringify({
            message: {
              role: "assistant",
              usage: { input: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          }),
          "corrupt line",
          JSON.stringify({
            message: {
              role: "assistant",
              usage: { input: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } },
            },
          }),
          JSON.stringify({ message: { role: "assistant", usage: "garbage" } }),
        ].join("\n"),
      );
      const state = createHeadroomState();
      await hydrateRealUsageFromTranscript(state, file);
      expect(state.realCostUsd).toBeCloseTo(0.03);
      expect(state.realInputTokens).toBe(15);
      // Missing/invalid path is a no-op.
      const fresh = createHeadroomState();
      await hydrateRealUsageFromTranscript(fresh, undefined);
      await hydrateRealUsageFromTranscript(fresh, join(root, "missing.jsonl"));
      expect(fresh.realCostUsd).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
