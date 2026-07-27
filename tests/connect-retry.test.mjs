import { describe, expect, test } from "bun:test";
import { CONNECT_BACKOFF_MS } from "../src/config.ts";
import { connectWithRetry } from "../src/index.ts";

// Minimal stubs — connectWithRetry only touches these fields on state and
// ctx.ui.notify. The probe/onRender/sleep seams let us drive the loop without
// spawning a proxy, touching the network, or waiting real backoff time.
const makeCtx = (notified = []) => ({ ui: { notify: (msg, lvl) => notified.push({ msg, lvl }) } });
const makeState = () => ({
  connectAttempt: 0,
  connectExhausted: false,
  proxyStarting: false,
  lastError: "",
});
const noopRender = () => {};
const scriptedProbe = (seq) => {
  let i = 0;
  return async () => seq[i++] ?? false;
};

describe("connectWithRetry", () => {
  test("succeeds on the first ready probe without sleeping", async () => {
    const state = makeState();
    const ok = await connectWithRetry(makeCtx(), state, {
      probe: scriptedProbe([true]),
      onRender: noopRender,
      sleep: () => {
        throw new Error("must not sleep when the first probe is already ready");
      },
    });
    expect(ok).toBe(true);
    expect(state.connectAttempt).toBe(0);
    expect(state.connectExhausted).toBe(false);
    expect(state.proxyStarting).toBe(false);
    expect(state.lastError).toBe("");
  });

  test("retries past earlier failures, sleeps between attempts, then resets", async () => {
    const state = makeState();
    let sleeps = 0;
    const ok = await connectWithRetry(makeCtx(), state, {
      probe: scriptedProbe([false, false, true]),
      onRender: noopRender,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(ok).toBe(true);
    // Slept after attempt 1 and after attempt 2; the successful attempt 3 returns before sleeping.
    expect(sleeps).toBe(2);
    expect(state.connectAttempt).toBe(0);
    expect(state.connectExhausted).toBe(false);
  });

  test("exhausts after exactly CONNECT_BACKOFF_MS.length attempts and warns once", async () => {
    const attempts = [];
    const notified = [];
    const ctx = makeCtx(notified);
    const state = makeState();
    const ok = await connectWithRetry(ctx, state, {
      probe: async () => {
        attempts.push(1);
        return false;
      },
      onRender: noopRender,
      sleep: async () => {},
    });
    expect(ok).toBe(false);
    expect(attempts.length).toBe(CONNECT_BACKOFF_MS.length);
    expect(state.connectExhausted).toBe(true);
    // Counter is reset to 0 so the widget shows the exhausted hint, not a stale "N/5".
    expect(state.connectAttempt).toBe(0);
    expect(state.lastError).toMatch(/\/headroom reconnect/);
    expect(notified).toHaveLength(1);
    expect(notified[0].msg).toMatch(/reconnect/);
    expect(notified[0].lvl).toBe("warning");
  });

  test("waits the configured backoff between attempts, but not after the last", async () => {
    const waits = [];
    await connectWithRetry(makeCtx(), makeState(), {
      probe: async () => false,
      onRender: noopRender,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    // Every schedule entry except the final one is followed by a sleep.
    expect(waits).toEqual(CONNECT_BACKOFF_MS.slice(0, -1));
  });

  test("reconnect entrypoint clears prior exhaustion before retrying", async () => {
    // A prior exhausted run leaves connectExhausted=true + a stale lastError;
    // re-entering connectWithRetry (what /headroom reconnect does) must clear
    // them so the widget does not show a stale "reconnect…" while retrying.
    const state = makeState();
    state.connectExhausted = true;
    state.lastError = "stale failure";
    await connectWithRetry(makeCtx(), state, {
      probe: scriptedProbe([true]),
      onRender: noopRender,
      sleep: async () => {},
    });
    expect(state.connectExhausted).toBe(false);
    expect(state.lastError).toBe("");
  });
  test("does not pre-set proxyStarting before probing, so ensureProxy's spawn guard stays open", async () => {
    // Regression: connectWithRetry once set state.proxyStarting = true before the
    // first probe, which defeated ensureProxy's `if (!state.proxyStarting && ...)
    // spawn` guard — the headroom binary was never launched and the
    // packed-plugin smoke timed out at 12s. proxyStarting is ensureProxy's to own.
    const captured = [];
    const state = makeState();
    await connectWithRetry(makeCtx(), state, {
      probe: async (_c, s) => {
        captured.push(s.proxyStarting);
        return true;
      },
      onRender: noopRender,
      sleep: async () => {},
    });
    expect(captured[0]).toBe(false);
  });
});
