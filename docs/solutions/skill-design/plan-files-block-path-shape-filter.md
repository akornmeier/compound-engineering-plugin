---
title: "Filter plan Files blocks by path shape — backtick spans include non-path inline code"
date: 2026-06-11
category: skill-design
module: compound-engineering / ce-verify-work
problem_type: convention
component: tooling
severity: high
applies_when:
  - Writing or modifying a parser that extracts declared files from a ce-plan Files block
  - Reviewing drift-rate output from ce-verify-work and seeing unexpectedly high missing-file counts
  - Adding a new plan-parsing step to any skill that reads a plan's Files section
tags:
  - ce-verify-work
  - ce-plan
  - plan-parsing
  - isPlausiblePath
  - drift-rate
  - path-filter
  - files-block
---

# Filter plan Files blocks by path shape — backtick spans include non-path inline code

## Context

A `ce-plan` Files block legitimately mixes real file paths with other inline code: shell commands (`bun run release:validate`), globs (`ce-*`), templated placeholders (`ce-<name>.md`), and bare identifiers (`import`, `fs`). All appear inside backticks in the same section.

A naive parser that extracts every backtick span from a Files block will surface non-paths as declared files. When `ce-verify-work` later checks whether those "files" exist, each non-path reads as a phantom missing file and inflates the drift rate, corrupting the `work-vs-plan` verdict.

This was surfaced by dogfooding `ce-verify-work` on the real probe plan in PR #11 (commit 9575c17): `parseFiles` extracted globs, placeholders, shell commands, and bare identifiers alongside real paths, inflating the missing-file count and producing false drift signals.

## Guidance

Any function that extracts declared files from a plan's Files block must apply a **path-shape filter** before treating a backtick span as a declared file. A span is a plausible path only when it satisfies all three conditions:

1. No whitespace — real paths do not contain spaces in this codebase's conventions
2. No glob or placeholder characters — reject spans containing `*`, `<`, or `>`
3. Path-shaped — must contain a directory separator (`/`), a trailing extension (`.ext`), or be a known extensionless filename (e.g., `Makefile`, `Dockerfile`, `AGENTS.md`, `CLAUDE.md`)

Spans that fail any condition are silently skipped; they are never counted as declared or missing.

The implementation in `ce-verify-work`'s workflow scripts names this function `isPlausiblePath` and mirrors it in both `workflows/drift-rollup.js` and `workflows/work-vs-plan-fanout.generated.js`.

## Why This Matters

Files blocks in plan markdown are authored prose — authors use inline code formatting for any token they want to highlight, not only file paths. A parser that doesn't distinguish paths from other inline code produces phantom "missing files," which:

- Inflate the `missing` count in a drift event
- Raise the drift rate for plan units whose authors wrote descriptive backtick content
- Cause `ce-verify-work` to flag plans as drifted when the implementation may be correct

The filter must be applied consistently in every script that reads a Files block. If the filter exists in one script but not a sibling that processes the same events, one path produces clean verdicts and the other produces inflated ones.

## When to Apply

- Implementing any new parser that reads a ce-plan `## Files` or `**Files:**` block
- Reviewing or porting an existing plan parser to a new workflow script
- Debugging unexpectedly high drift rates — check whether the parser applies the path-shape filter before counting declared or missing files

## Examples

Given a Files block like:

```markdown
**Files:**
- `src/converters/opencode.ts`
- `tests/converter.test.ts`
- `bun run release:validate`
- `ce-*`
- `ce-<name>.md`
- `import`
- `fs`
```

A naive `backtick-everything` extractor produces seven declared files; five are phantoms that will read as missing.

After the path-shape filter:

| Span | Has `/` or ext or known extensionless? | Glob/placeholder chars? | Verdict |
|---|---|---|---|
| `src/converters/opencode.ts` | yes (`/` + `.ts`) | no | path |
| `tests/converter.test.ts` | yes (`/` + `.ts`) | no | path |
| `bun run release:validate` | no (whitespace) | — | skip |
| `ce-*` | no (no `/`, no ext) + `*` | yes | skip |
| `ce-<name>.md` | has `.md` | yes (`<`, `>`) | skip |
| `import` | no | no | skip |
| `fs` | no | no | skip |

Result: two declared files, both real — zero phantom missing-file counts.

## Related

- `workflows/drift-rollup.js` — defines `isPlausiblePath`; sibling filter in `work-vs-plan-fanout.generated.js`
- `docs/solutions/skill-design/capture-gate-avoid-selection-bias.md` — companion note on the capture gate for drift events; path-shape filtering is the extraction side, capture-gate is the write side
- PR #11 (commit 9575c17) — the dogfooding run that surfaced this; the extensionless-filename allowlist refinement from the same PR is a separately captured learning
