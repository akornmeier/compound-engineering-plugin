---
title: "Keep workflow/fallback/test parity via a canonical pure module inlined at build time"
date: 2026-06-11
category: architecture-patterns
module: "compound-engineering / ce-verify-work"
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "A skill has both a dynamic-workflow path and a prose fallback that must produce the same numeric output"
  - "The Workflow runtime cannot import sibling files but the same deterministic logic is needed in the workflow, the prose fallback, and unit tests"
  - "A rate, score, or classification must not diverge across the workflow path, the fallback path, and tests"
tags:
  - dynamic-workflows
  - build-time-assembly
  - canonical-module
  - parity
  - determinism
  - prose-fallback
  - skill-design
  - ce-verify-work
---

# Keep workflow/fallback/test parity via a canonical pure module inlined at build time

## Context

`ce-verify-work` computes a plan drift rate from classified Implementation Unit verdicts. The computation must be identical across three execution paths:

1. **The dynamic workflow** (`work-vs-plan-fanout.generated.js`) — runs in the Workflow runtime, fans out classifier agents, then rolls up verdicts deterministically.
2. **The prose fallback** (SKILL.md Phase 2) — runs when the Workflow tool is unavailable (Codex, Gemini, etc.) and the LLM must apply the same rules manually.
3. **Unit tests** (`bun test`) — validate the roll-up logic in isolation.

The Workflow runtime is self-contained and cannot `import` sibling files. The natural temptation when building this is to either duplicate the logic (one copy in the workflow script, one in the fallback, one implied in tests), or to try a runtime `import` that will silently fail. Neither produces a parity guarantee.

## Guidance

Keep the deterministic logic (parser + math) in **one canonical, unit-tested pure module**. Inline it into the workflow script at build time via a unique merge marker. The prose fallback cites that module's rules verbatim. Pin the generated artifact with a freshness test.

**1. Write a pure module with no Workflow/Agent/filesystem dependencies.**

The module must be importable by `bun test` and designed to be inlined into the workflow script. In `ce-verify-work`, this is `workflows/drift-rollup.js`:

```
// Pure module: no Workflow/Agent/filesystem dependencies. It is importable by
// `bun test` AND designed to be inlined into the dynamic workflow script (the
// Workflow runtime is self-contained and cannot `import` a sibling file, so
// work-vs-plan-fanout.js prepends this module's function bodies; the single
// trailing `export` line is the only thing that must be stripped on inline).
// The orchestrator's pre-dispatch validation and the prose fallback both reuse
// parsePlanUnits / rollupVerdicts, so the rate cannot diverge across paths.
```

**2. Place a unique merge marker in the workflow template.**

The fan-out template (`work-vs-plan-fanout.js`) is a **template**, not independently runnable — the module functions are undefined until assembly. Mark the insertion point with a single unique comment:

```js
/* __MERGE_MODULE__ */
// Assembly inserts drift-rollup.js here, exposing parsePlanUnits(planText) and
// rollupVerdicts(verdicts).
```

The Workflow runtime also requires `export const meta` to be the **first statement** of the script. Structure the template with `export const meta` before the marker so assembly preserves ordering.

**3. Assemble at build time via a script; commit the generated artifact.**

A build script (`scripts/build-work-vs-plan-workflow.ts`) reads both source files, strips the module's trailing `export { ... };` line (the only part invalid inside an export-less workflow script), injects at the marker, and writes the committed `work-vs-plan-fanout.generated.js`. The SKILL.md guard reads that generated artifact and hands it verbatim to the Workflow tool — **no runtime text-surgery**:

```
// At BUILD TIME, scripts/build-work-vs-plan-workflow.ts inlines that module
// (minus its trailing `export`) at the merge-module marker below and writes
// the committed, runnable `work-vs-plan-fanout.generated.js`.
// The SKILL.md guard reads that generated artifact and hands it to the Workflow
// tool verbatim — there is no runtime assembly.
```

**4. Pin the generated artifact with a freshness test.**

A parity test (`tests/work-vs-plan-workflow-parity.test.ts`) regenerates the workflow from the same sources and compares it byte-for-byte against the committed artifact. A stale committed file fails the test:

```
// A freshness test asserts the committed generated file matches its sources
// and keeps meta first.
```

**5. The prose fallback must apply the module's rules verbatim — not improvise the math.**

The prose fallback instruction in SKILL.md cites the module explicitly and reproduces its rules (denominator formula, evidence-required set, low-confidence thresholds) inline so the LLM has no latitude to invent different math:

> "Roll the verdicts up with the same deterministic rules the workflow uses — do not improvise the math. `workflows/drift-rollup.js` (`rollupVerdicts`) is the single source of truth; the workflow and this fallback share it, so the rate cannot diverge."

If the platform has a JS runtime and can locate the module, running it is the most exact path. Otherwise the fallback applies the rules verbatim as listed.

## Why This Matters

Without this pattern, the next author to touch the skill faces three silent failure modes:

- **`import` that fails at runtime.** The Workflow sandbox has no module resolution — `import { rollupVerdicts } from './drift-rollup.js'` throws at workflow startup, and static tests (which run outside the sandbox) never catch it.
- **Hand-duplicated logic that drifts.** A copy in the workflow script and a separate copy in the fallback start identical but diverge as either is updated, so the rate silently differs between execution paths.
- **Stale generated artifact.** If the build step is skipped after editing the template or module, the committed generated script is stale — the old logic ships while the new logic only exists in unassembled source.

The parity guarantee comes from the build-time assembly + freshness test combination: the freshness test fails CI when the generated artifact drifts, forcing a rebuild before merge. The prose fallback's verbatim-citation rule prevents the fallback path from silently diverging on its own.

## When to Apply

- Any skill whose Workflow-path logic must match a prose fallback path for numeric or categorical output — the denominator for a rate, the criteria for a classification, the merge rules for a roll-up.
- Any workflow script that shares deterministic logic with unit tests: the pure-module pattern makes the logic importable from `bun test` and inlineable into the runtime, so the same code covers both.
- **Not needed** when the workflow path and the prose fallback use different logic intentionally (e.g., the prose fallback is a simplified approximation with an explicit "this is approximate" caveat) or when the skill has no prose fallback at all.

## Examples

The canonical instance is `ce-verify-work`. Its file layout:

```
plugins/compound-engineering/skills/ce-verify-work/workflows/
  drift-rollup.js                     # canonical pure module (importable by tests)
  work-vs-plan-fanout.js              # template — NOT independently runnable
  work-vs-plan-fanout.generated.js    # committed generated artifact (DO NOT EDIT)

scripts/
  build-work-vs-plan-workflow.ts      # assembles template + module -> generated

tests/
  work-vs-plan-workflow-parity.test.ts  # freshness test: regenerate and compare
```

The SKILL.md guard in Phase 2:

```
Read `workflows/work-vs-plan-fanout.generated.js` and pass it verbatim to the
Workflow tool.
```

The prose fallback in SKILL.md Phase 2 names the module and quotes its rules so the LLM cannot stray. The freshness test fails CI if `build-work-vs-plan-workflow.ts` was not run after editing either source.

## Related

- `docs/solutions/skill-design/dynamic-workflow-conversion-live-boundary.md` — the sibling doc cataloging live-boundary contracts (args parsing, agentType namespacing, dispatch error logging, no filesystem access, minimal inline schema, no `Date.now()`). Those are *runtime* contracts; this doc is about the *build-time assembly* pattern that prevents parity drift. A workflow that uses this assembly pattern still needs to satisfy the live-boundary contracts.
- `docs/solutions/skill-design/verbatim-copy-grouped-projection-from-script.md` — a related pattern: when a script produces a grouped projection, the orchestrator copies it verbatim rather than re-deriving from the flat source. Shares the same root principle: one source of truth, no re-derivation.
