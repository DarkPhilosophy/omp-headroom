# Changelog

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
- Release gates use frozen Bun installs, Biome, TypeScript, behavioral tests, Ruff, the leak scanner, OSV dependency scanning, package allowlisting, and an extracted-tarball OMP plugin smoke test.

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
