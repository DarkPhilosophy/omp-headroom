# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(with the 0.x convention that a `0.1.y` bump may include additive features, and
`0.(x+1).0` reserves room for a larger or breaking change).

## [0.1.4] - 2026-07-27

### Added

- **Bounded connect retry with backoff.** `connectWithRetry()` probes the proxy
  readiness across `CONNECT_BACKOFF_MS` (`[5, 10, 20, 40, 60]` seconds, env
  overridable via `OMP_HEADROOM_CONNECT_BACKOFF_MS`) instead of failing fast at
  the single-shot `ensureProxy` probe. A slow cold-start (heavy ML model import
  on a memory-constrained box where even `/livez` is starved for tens of
  seconds) now has ~135 s to come up instead of giving up at ~25 s.
- **`getLivez()` readiness probe** in `proxy.ts`, returning
  `{ alive, healthy, version, uptime }` from the proxy `/livez` endpoint.
- **`/headroom reconnect` subcommand** — a manual escape hatch that resets the
  exhaustion flag and re-enters `connectWithRetry` after the auto loop gave up.
- **Widget hint on exhaustion** — shows a one-shot "proxy not ready, run
  `/headroom reconnect`" message instead of a stale "N/5" counter.
- **`ConnectRetryOptions` test seam** on `connectWithRetry` (injectable
  `probe` / `onRender` / `sleep`) so the loop is testable without spawning a
  proxy, touching the network, or waiting real backoff.

### Changed

- `state.connectAttempt` / `state.connectExhausted` are reset on success and on
  re-entry, so the widget reflects current state instead of stale failures.
- Bootstrap now calls `connectWithRetry` after the install maintenance step so a
  freshly provisioned proxy is given the full backoff window before the session
  treats it as unreachable.
- `fetchStats` default timeout bumped from 3 s to 8 s to tolerate the same
  slow-cold-start regime on the stats endpoint.

### Fixed

- `connectWithRetry` now clears `state.lastError` on entry, so after a
  successful `/headroom reconnect` the widget no longer shows the previous
  exhaustion message.
- Exhaustion `notify` uses the canonical `"warning"` level (the OMP API accepts
  `"info" | "warning" | "error"`); the previous `"warn"` literal was not in the
  union.

### Tests

- New `tests/connect-retry.test.mjs` — 5 contracts: immediate success without
  sleeping, retry-then-success with correct sleep count, exact exhaustion after
  `CONNECT_BACKOFF_MS.length` attempts with a single warning, backoff schedule
  equals `CONNECT_BACKOFF_MS.slice(0, -1)`, and reconnect clears prior
  exhaustion before retrying. Suite is now **93 pass / 0 fail** (was 88).

## [0.1.3] - 2026-07-23

### Added

- `/headroom config` — effective values with per-key source and the config file
  path.
- `/headroom set <key> <value>` — atomic `headroom.yml` persistence with key
  completion and validation.
- Declarative `HEADROOM_SETTINGS` registry driving both subcommands, invalid
  override warnings, and privacy-safe Anthropic gate diagnostics in the sizing
  log.

### Fixed

- Anthropic OAuth sessions compress and archive again. OMP encodes custom tool
  names on the Claude wire with a leading underscore, so the registered
  `headroom_retrieve` arrived as `_headroom_retrieve` and the strict name gate
  failed closed on every request — no `/v1/compress` calls, no proxy session
  registration, frozen `req`/`tool` counters. The gate now accepts both
  spellings.

### Changed

- Synced tooling with omp-discord: Biome 2.5.4 schema, ES2023 lib.

---

Releases prior to 0.1.3 are not retroactively documented; see `git log` for
their full history.
