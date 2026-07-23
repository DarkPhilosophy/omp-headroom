# Changelog

## 0.1.3 — 2026-07-23

### Fixed

- Anthropic OAuth sessions now compress and archive again. OMP encodes custom tool names on the Claude wire with a `_` prefix, so the registered `headroom_retrieve` arrived as `_headroom_retrieve` and the strict name gate failed closed on every request: no `/v1/compress` calls, no proxy session registration, and frozen `req`/`tool` counters while Codex sessions kept working. The gate now accepts both spellings.

### Added

- `/headroom config` lists every setting with its effective value and source (env override, `headroom.yml`, or default), plus the config file path.
- `/headroom set <key> <value>` persists one setting to `headroom.yml` atomically, with key completion, per-kind validation, on/off value completion for booleans, and an explicit warning when an env var overrides the saved value.
- A declarative settings registry (`HEADROOM_SETTINGS`) now drives the config listing, completion, validation, and persistence from one table.
- Privacy-safe Anthropic gate diagnostics in the sizing log (`debug_sizing`): per-request tool-result block counts, eligibility against the adaptive threshold, retrieve-tool presence, and proxy readiness — sizes and booleans only, never content.

## 0.1.2 — 2026-07-19

### Fixed

- Session archive truncation now preserves Unicode surrogate pairs and repairs malformed UTF-16, preventing OpenAI Codex from rejecting resumed sessions with an invalid Unicode payload.

## 0.1.1 — 2026-07-19

### Added

- Provider prompt-cache telemetry is now accumulated per session and shown on a dedicated widget row with a token-weighted hit rate plus cache read/write token totals.

## 0.1.0 — 2026-07-18

### Fixed

- Current OMP Responses Lite payloads now find the essential `headroom_retrieve` tool inside the leading `additional_tools` input item, restoring automatic compression in both daemon and direct modes.
- The obsolete `omp_stats` proxy extension was removed because Headroom 0.32 records `/v1/compress` outcomes natively; this prevents doubled request and savings totals without carrying a legacy wrapper.
- Session startup no longer sends a synthetic `gpt-4o-mini` compression request. Headroom 0.32 performs its own eager preload, so the redundant request only polluted global dashboard statistics.
- Responses requests now aggregate individually-small tool outputs once their combined size clears the adaptive threshold, while preserving each call ID and accepting the batch only after every changed output has a durable retrieval marker.
- When OMP is already launched through upstream `headroom wrap omp`, the extension detects the project-prefixed Anthropic endpoint and skips its SDK hook to prevent double compression.

## 0.1.0-beta.4 — 2026-07-16

### Added

- The repository is now an OMP plugin marketplace (`.omp-plugin/marketplace.json`). Installing via `omp plugin marketplace add DarkPhilosophy/omp-headroom` + `omp plugin install omp-headroom@darkphilosophy` enables managed upgrades (`omp plugin upgrade`, or automatic upgrades with the `marketplace.autoUpdate = auto` setting). The release gate verifies the catalog version matches the package version.
- The host peer range now covers OMP 16.4+ and 17.

### Fixed

- `headroom_retrieve` now registers with `loadMode: "essential"` so OMP hosts with deferred/discoverable custom tools (OMP 17+) keep it in the outbound provider payload. On OMP 17 the tool silently moved out of `payload.tools`, so the strict fidelity gates correctly failed closed and the extension passed every request through unmodified — no compression, no automatic prefix archiving, no error, and no visible sign beyond frozen widget counters. `/headroom compact` CCR archiving was unaffected.

## 0.1.0-beta.3 — 2026-07-11

### Fixed

- OMP attribution now points at the canonical `can1357/oh-my-pi` repository; the previous link target did not exist. The README license link was repaired after the move to the repository root.

### Removed

- npm versions `0.1.0-beta.1` and `0.1.0-beta.2` were unpublished because their tarballs embedded the broken attribution; repository history was rewritten to remove the stale reference entirely.

## 0.1.0-beta.2 — 2026-07-11

### Fixed

- First-time venv provisioning now always runs when the Headroom binary is missing at session start. `OMP_HEADROOM_AUTOUPDATE=0` previously skipped initial installation entirely; it now disables only the daily update poll.
- The npm package now ships its README at the tarball root so the registry page renders it; GitHub continues to render the same file from the repository root.

## 0.1.0-beta.1 — 2026-07-11

### Added

- Added a publishable OMP plugin package. npm installs the modular `src/` runtime together with the Python `omp_stats` plugin, service template, license, and canonical documentation.
- Added `/headroom` argument completion and help for `stats`, `on`, `off`, `compact`, `clear`, `test`, `service`, `help`, `version`, `config`, `debug`, `start`, `stop`, `restart`, and `update`.
- Added `/headroom compact` as a distinct Headroom-assisted compaction path: it arms a one-shot OMP `session.compacting` hook, atomically archives the complete discarded source under a CCR hash, adds fidelity guidance, and then lets OMP produce its semantic LLM summary. Plain OMP `/compact` does not activate this archive.
- Added `/headroom test tool` and `/headroom test compaction` fixtures for real proxy compression and native OMP compaction behavior.
- Added `/headroom service install|status|uninstall` for explicit `systemd --user` lifecycle management. Installation preserves a differing existing unit rather than overwriting it.
- Added privacy-safe per-request sizing diagnostics and native OMP compaction accounting in the live widget.
- Added guarded `/headroom clear session [confirm]` lifecycle management. The confirmation form deletes only the current session's owned CCR directory and persisted archive counters.

- Compression is accepted only when Headroom reports a strict token reduction, the actual outgoing message payload is smaller, every user message is byte-stable, the registered `headroom_retrieve` tool is already present, and an atomic session-owned local CCR fallback has been persisted.
- Missing, equal, increasing, fractional, or contradictory token metrics fail closed to the original provider payload; reported savings are derived from `tokens_before - tokens_after`.
- OpenAI and Responses preserve their provider shape. Anthropic compression is intentionally limited to isolated `tool_result` blocks because a holistic Anthropic→OpenAI→Anthropic conversion cannot preserve arbitrary structured content or trustworthy token counts.
- Automatic compression is on-wire only; visible OMP tool-result messages are never rewritten.
- The OMP plugin owns venv provisioning, Headroom updates, GPU preservation, proxy startup, and optional `/headroom service` management.
- Python provisioning prefers `uv` but falls back to the standard-library `venv` module and the environment's own `pip`; no separate `uv` installation is required.
- The widget keeps the unified `arch Nch ×M` metric (automatic Headroom provider-prefix archive savings and count) independent from `com N` (all completed OMP compactions). Archive savings are recorded immediately after the full stable prefix is persisted, never from `session_compact`.
- The update lifecycle preserves ROCm Torch on AMD hardware and distinguishes extension-owned proxy processes from shared service-managed processes.

- User messages remain byte-stable; any proxy mutation rejects the complete compressed response.
- Responses and Anthropic fragment compression require a strict token reduction before changing the outbound payload.
- Compressed content is exposed only after its full original is durably persisted, including holistic provider compression.
- Failed or no-op compression leaves the retrieval-tool schema and provider payload unchanged.
- Anthropic handling preserves string user messages and structured tool-result content without lossy holistic conversion.
- Warmup requests are excluded from proxy savings statistics.
- Generated systemd units protect line-breaking paths and escape literal `%` specifiers.
- Automatic tool compression remains transcript-safe; updates preserve AMD ROCm wheels, reconcile shared proxies, and clear update state reliably.
- Automatic provider-prefix archival populates the unified `arch Nch ×M` metric; native `/compact` and `/headroom compact` increment only `com`.
- Archive totals and CCR originals are atomically persisted by full session ID and hydrated on `omp --resume`. Retrievable originals no longer expire by wall-clock age; explicit confirmed clearing preserves other sessions and unowned legacy files. `/headroom version` reports a source fingerprint for the loaded build.

### Removed

- Removed the legacy monolithic `extension/headroom.ts` mirror and `.scripts/sync-extension.mjs`; `src/index.ts` is the only runtime entrypoint.
- Removed manual retrieval-tool injection from provider hooks. OMP's registered tool must already be present, preventing tool-schema overhead from turning a nominal compression into a larger request.
- Removed `install.sh`; installation and development linking use OMP's native `plugin install` / `plugin link` lifecycle.

### Verification

- Deterministic tests cover strict token reduction, missing/equal/increasing metrics, user-message fidelity, automatic provider-prefix archival, resume-safe archive totals, archive-chain recovery, session-owned CCR persistence and guarded cleanup, independent `arch`/`com` counters, distinct `/headroom compact` semantics, service rendering, package assets, and command dispatch.
- Release gates use frozen Bun installs, Biome, TypeScript, behavioral tests, the leak scanner, OSV dependency scanning, package allowlisting, and an extracted-tarball OMP plugin smoke test.

## Earlier unversioned development history

The repository previously described this state as `v0.1.0`, but it was never tagged or released.

### Added

- Initial OMP extension with three model-callable tools:
    - `headroom_compress`
    - `headroom_retrieve`
    - `headroom_stats`
- Local Headroom proxy integration for OpenAI `messages`, Anthropic messages, and OpenAI Responses `input`.
- Transparent provider-request compression and oversized tool-result compression.
- Local CCR fallback storage for retrieval when the proxy store misses.
- Context-pressure adaptive provider and tool thresholds.
- Automatic session-prefix archival with a retrievable structural index and live-tail preservation.
- Session/lifetime widget with request, tool, CCR, archive, token-savings, and cost counters.
- Shared statistics across the main OMP session and background agents.
- Daily PyPI update checks and in-place `headroom-ai[all]` upgrades.
- CUDA/ROCm preservation across updates.
- GPU-aware installer for NVIDIA, AMD, and CPU environments.
- Optional persistent `systemd --user` service.
- `omp_stats` proxy plugin for `/stats` observability when using Headroom through the SDK.
- CI quality gates, repository leak scanning, and the initial deterministic test suite.

### Changed

- Replaced the earlier standalone widget extension with one integrated Headroom extension.
- Switched from a system-Python installation to an extension-managed virtual environment.
- Moved proxy statistics from guessed local counters to session-aware `/stats` data where available.

### Fixed

- Prevented model-visible tools from disappearing after compressed content entered the provider payload.
- Preserved tool-call identifiers and message roles across OpenAI, Anthropic, and Responses conversions.
- Prevented foreign/background agent activity from overwriting the main UI widget.
- Prevented proxy stats from being attributed to a fresh OMP session before its first real request.
- Prevented malformed or missing local CCR files from breaking retrieval.
