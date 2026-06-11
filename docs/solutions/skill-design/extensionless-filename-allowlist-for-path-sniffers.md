---
title: "Pair path-shape rules with an extensionless-filename allowlist — well-known files have no extension"
date: 2026-06-11
category: skill-design
module: compound-engineering / ce-verify-work
problem_type: design_pattern
component: tooling
severity: high
applies_when:
  - Writing or modifying any function that decides whether a string is a file path
  - Reviewing drift-rate output from ce-verify-work and seeing legitimate declared files counted as missing
  - Porting a path-shape filter to a new workflow script or skill
tags:
  - ce-verify-work
  - isPlausiblePath
  - path-filter
  - extensionless
  - false-negative
  - plan-parsing
  - drift-rate
---

# Pair path-shape rules with an extensionless-filename allowlist — well-known files have no extension

## Context

A path-shape filter that accepts only strings containing a `/` separator or a trailing `.ext` extension silently rejects well-known extensionless repo files — `Dockerfile`, `Makefile`, `LICENSE`, `Procfile`, `Gemfile`, `Rakefile`, and others. These are legitimate declared files, but the shape rule has no way to distinguish them from bare identifiers like `import`, `fs`, or `Read`.

This false-negative class was discovered in a code review of PR #11 (commit 08edc50), which introduced `isPlausiblePath` in `ce-verify-work`'s drift-rollup scripts. The reviewer noted that the initial rule — requiring `/` or `.ext` — would silently drop any extensionless filename a plan author had declared. Dotfiles (`.gitignore`) already pass because the leading dot reads as `.ext`; plain capitalized filenames do not.

## Guidance

Any path-sniffing function must pair its shape rule with a **case-insensitive allowlist of known extensionless filenames**. A token with no `/` and no `.ext` is a real path only when it matches the allowlist; otherwise it is silently skipped.

Three-rule implementation shape:

1. **Whitespace**: reject immediately — real paths in this codebase contain no spaces
2. **Glob/placeholder characters**: reject tokens containing `*`, `?`, `<`, `>` — these are globs, templates, or placeholders
3. **Path-shaped**: accept when the token contains `/` OR matches `/\.[A-Za-z0-9]+$/` (trailing extension) OR matches the case-insensitive extensionless allowlist

The allowlist should cover the common set. The one in `workflows/drift-rollup.js` is the reference implementation:

```js
const EXTENSIONLESS_FILES = new Set([
  "dockerfile", "makefile", "license", "procfile", "gemfile", "rakefile",
  "jenkinsfile", "brewfile", "vagrantfile", "caddyfile", "justfile", "containerfile",
  "notice", "authors", "contributors", "codeowners", "readme", "changelog", "version",
]);

function isPlausiblePath(p) {
  if (/\s/.test(p)) return false;
  if (/[*<>]/.test(p)) return false;
  if (p.includes("/") || /\.[A-Za-z0-9]+$/.test(p)) return true;
  return EXTENSIONLESS_FILES.has(p.toLowerCase());
}
```

The allowlist is heuristic, not exhaustive. An obscure extensionless file not on the list is still dropped; that is acceptable for a Files-block scanner where precision on the common set matters more than recall on unusual filenames.

## Why This Matters

The false-negative is silent — no error, no warning, no count. A declared `Dockerfile` or `Makefile` just disappears from the extracted set and is never checked. In a drift-rate pipeline this means:

- A plan that declares `Dockerfile` as a file to create produces a false "missing" count if the filter has been applied incorrectly after the allowlist landed, or a false "skipped" count if the token was never extracted at all
- The `work-vs-plan` verdict may read as drifted when the implementation was correct

The pattern transfers to **any path-sniffing code**, not only plan-parsing: lint scripts, search-path resolvers, file-existence checkers, test fixtures that validate declared paths — any function that uses a shape rule to classify strings as paths will have this false-negative class unless the allowlist covers the extensionless case.

## When to Apply

- Implementing a new `isPlausiblePath`-style function in any workflow script
- Porting an existing path filter to a new context — carry the allowlist alongside the shape rule
- Debugging unexpectedly missing declared files — check whether the filter was copied without its allowlist

## Examples

Given a Files block that includes:

```markdown
- `src/converters/opencode.ts`
- `Dockerfile`
- `Makefile`
- `import`
- `fs`
```

**Without allowlist** (shape rule only — `/` or `.ext` required):

| Span | Result |
|---|---|
| `src/converters/opencode.ts` | path (has `/` + `.ts`) |
| `Dockerfile` | **silently dropped** — no `/`, no `.ext` |
| `Makefile` | **silently dropped** — no `/`, no `.ext` |
| `import` | skipped (correct) |
| `fs` | skipped (correct) |

**With allowlist** (shape rule + extensionless set):

| Span | Result |
|---|---|
| `src/converters/opencode.ts` | path |
| `Dockerfile` | path (allowlist match) |
| `Makefile` | path (allowlist match) |
| `import` | skipped (correct) |
| `fs` | skipped (correct) |

## Related

- `workflows/drift-rollup.js` — reference implementation of `isPlausiblePath` with `EXTENSIONLESS_FILES`; the same pattern is mirrored in `workflows/work-vs-plan-fanout.generated.js`
- `docs/solutions/skill-design/plan-files-block-path-shape-filter.md` — companion: addresses the false-positive class (backtick spans that are not paths get included); this doc addresses the false-negative class (valid extensionless paths get excluded). Both refine the same `isPlausiblePath` function; the filter landed first, the allowlist closed the gap discovered in code review
- PR #11 (commit 08edc50, review thread discussion_r3374944540) — where the gap was caught and the allowlist was added
