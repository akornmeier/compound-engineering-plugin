# CLI / Converters

The Bun + TypeScript CLI (`compound-plugin`) that parses a Claude Code plugin and converts it into other agent-platform formats. Owns parsing, conversion, target writers, and the release-metadata library. Does NOT own plugin content (see `plugins/compound-engineering/AGENTS.md`) or the marketplace catalog files (`.claude-plugin/`, `.cursor-plugin/`, `.agents/`) — `release/` only syncs their descriptions.

## Entry Points

- `index.ts` — citty CLI; registers subcommands `convert`, `install`, `list`, `cleanup`, `plugin-path`.
- `commands/` — one file per subcommand; argument parsing and orchestration only.
- `parsers/claude.ts` — reads a Claude plugin into the canonical `ClaudePlugin` shape.
- `targets/index.ts` — the target registry: maps each target name to a `{ convert, write }` handler. Start here to see which targets are live.

## Flow

`parse (parsers/claude.ts -> ClaudePlugin)` -> `convert (converters/claude-to-<target>.ts)` -> `write (targets/<target>.ts)`. The registry in `targets/index.ts` wires convert+write together per target.

## Contracts & Invariants

- **Claude is the source shape.** Conversion is one-directional (Claude -> provider). `types/claude.ts` + `parsers/claude.ts` are canonical; other `types/*.ts` describe per-target output shapes.
- **Adding/changing a target follows the root checklist.** See "Adding a New Target Provider" in the repo-root `AGENTS.md` — registry entry, types + explicit mapping, CLI wiring, tests (converter + writer + CLI), docs. Tests are required alongside implementation, not after.
- **Output paths and merge semantics are stable.** OpenCode writes `opencode.json` (deep-merged, never overwritten wholesale) and `.opencode/{agents,skills,plugins}`. Do not casually relocate generated files.
- **Legacy-cleanup registries are paired.** When removing a skill/agent/command, update both `utils/legacy-cleanup.ts` (`STALE_*`) and `data/plugin-legacy-artifacts.ts` so stale flat-install artifacts get swept.
- **Release-metadata logic lives in `release/`; the runnable entrypoints are repo-root `scripts/release/*.ts`.** `bun run release:validate` runs detect-only (`write: false`) and fails on drift; `release:sync-metadata --write` applies description corrections. Plugin **version** bumps are owned by release-please, not written here (Codex version sync is explicitly detect-only). See repo-root `AGENTS.md` for the workflow.

## Anti-patterns

- Don't scatter target-specific conditionals across shared files. Keep per-target behavior in its dedicated `converters/claude-to-<target>.ts` and `targets/<target>.ts`.
- Don't add a converter without a registry entry and tests, or change generated output locations/merge semantics without updating fixtures.

## Pitfalls

- `claude-to-droid` and `claude-to-copilot` have converters, types, and converter tests, but **no writer (`targets/<name>.ts`) and no `targets/index.ts` registry entry** — unwired/in-progress targets. A converter (or its test) existing does not mean the target is live; the registry is the source of truth.

## Related Context

- Plugin content being converted: `../plugins/compound-engineering/AGENTS.md`
- Tests and fixtures: `../tests/` (`converter.test.ts`, writer tests, `cli.test.ts`)
