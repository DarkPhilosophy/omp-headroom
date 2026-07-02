# Contributing

Thanks for looking at omp-headroom! Small, focused PRs are the easiest to review.

## Ground rules

1. **Fidelity first.** Any change to compression/compaction must keep originals retrievable. If a payload byte disappears, a `hash=` marker pointing at the stored original must replace it. PRs that trade fidelity for ratio will be declined.
2. **The extension is one file by design.** `extension/headroom.ts` is a mirrored artifact of the installed copy — OMP loads a single module. Keep helpers pure and testable instead of splitting files.
3. **Tests before behavior.** Compactor logic changes need a failing test first (`tests/`). Pure functions (`createSessionCompaction`, `adaptiveMinChars`, `expandSessionArchiveText`, …) are exported precisely so they can be tested without a live proxy.

## Workflow

```bash
bun install          # dev deps (eslint, prettier)
bun run verify       # bun --check + bun test + leak scan — must pass
bun run lint         # eslint on tests/.scripts
bun run lint:py      # ruff on plugins/
```

- `bun run sync` shows drift between the repo copy and your installed extension (`~/.omp/agent/extensions/headroom.ts`).
- `bun .scripts/scan-leaks.mjs` runs the pre-publish leak gate; CI enforces it.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`) keep the changelog easy to generate.

## Reporting issues

Use the issue templates. For compression bugs, include the payload **shape** (provider, item types, sizes) — never the payload content itself.
