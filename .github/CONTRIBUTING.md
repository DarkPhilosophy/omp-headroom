# Contributing

Thanks for looking at omp-headroom! Small, focused PRs are the easiest to review.

## Ground rules

1. **Fidelity first.** Compression is accepted only when proxy metrics prove a strict token reduction, the outgoing payload is smaller, every user message is unchanged, and the original is persisted under a retrievable CCR hash. PRs that trade fidelity for ratio will be declined.
2. **Keep runtime responsibilities modular.** `src/index.ts` wires OMP hooks; focused helpers belong in the adjacent `src/*.ts` modules. The npm package loads `src/index.ts` directly.
3. **Tests before behavior.** Compression or compaction changes need a failing test first under `tests/`, including fail-closed edge cases.

## Workflow

```bash
bun install          # locked development dependencies
bun run check        # Biome format + lint
bun run typecheck    # TypeScript, no emit
bun run test         # deterministic behavior and integration fixtures
bun run verify       # check + typecheck + test + leak scan
bun run lint:py      # Ruff on the proxy stats plugin
```

- `bun .scripts/scan-leaks.mjs` runs the pre-publish leak gate; CI enforces it.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`) keep the changelog easy to generate.

## Reporting issues

Use the issue templates. For compression bugs, include the payload **shape** (provider, item types, sizes) — never the payload content itself.
