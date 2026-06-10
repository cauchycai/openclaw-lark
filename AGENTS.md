# Repository Guidance

## Version Bumps

- Use the current release date for version lines. For example, changes released on 2026-06-10 should use `2026.6.10`, not an increment of an older date such as `2026.6.3.x`.
- Keep `package.json` `version` on the date version: `YYYY.M.D`.
- Keep `package.json` `openclawFork.version` on the fork patch version: `YYYY.M.D.x`, where `x` starts at `1` for the first TuringClaw fork bump that day and increments for additional bumps on the same date.
- When changing either version field, update `tests/version.test.ts` so `getPluginVersionDisplay()` and `getUserAgent()` expectations match.
- Verify version metadata with `pnpm vitest run tests/version.test.ts`.
