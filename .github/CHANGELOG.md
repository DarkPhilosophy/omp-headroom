# Changelog

## v0.1.0 — initial public release

### Extension
- Provider-path compression for OpenAI `messages`, Anthropic, and OpenAI Responses (`input`) payloads.
- Tool-output compression with CCR retrieval (`headroom_retrieve`) and on-disk fallback store.
- Session archive compaction: stable prefix folds into one indexed, retrievable archive message; archives chain across re-compactions and every archive file is self-contained (TTL cleanup cannot break the chain).
- Adaptive thresholds: compression bar drops linearly once context usage passes 50%, bottoming at 25% of the base threshold at 90% usage (`OMP_HEADROOM_ADAPTIVE*`).
- Bounded parallel compression for Responses tool outputs (`OMP_HEADROOM_RESPONSES_CONCURRENCY`, default 3).
- Fire-and-forget stats refresh: provider requests no longer wait on the stats endpoint.
- Compact 4-row widget: rounded corners, title + short session id in the top border, session/lifetime savings and session input cost in the bottom border.
- Autoupdate from PyPI with ROCm torch re-pin survival.

### Tooling
- `install.sh` with NVIDIA/AMD/CPU auto-detection and optional systemd --user unit.
- `omp_stats` proxy plugin: records `/v1/compress` outcomes into `/stats` for SDK-only deployments.
- CI: `bun --check`, compactor + adaptive test suites, eslint, ruff, leak scan.
