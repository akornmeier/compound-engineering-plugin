---
title: Keep synthetic artifacts out of real telemetry directories
date: 2026-06-11
category: conventions
module: compound-engineering / ce-verify-work
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - A test or fixture run produces an artifact that resembles a real telemetry record
  - Verifying new telemetry capture code by running it against a fixture input
  - Any test that produces a file in a directory consumed by downstream aggregation
tags:
  - test-hygiene
  - telemetry
  - drift-events
  - fixtures
  - aggregation
  - synthetic-artifacts
---

# Keep synthetic artifacts out of real telemetry directories

## Context

PR #14 (commit 379d133) introduced a smoke test (`tests/work-vs-plan-workflow-eval.test.ts`) that exercised the drift-event capture path using a fixture input. The test produced a real-looking drift-event file and wrote it to `docs/drift-events/` — the same directory a future Signal-gate aggregation will read to compute drift rates across production probe runs.

The fixture-derived event looked identical to a real telemetry record (same schema, same directory, valid frontmatter) but its contents came from a synthetic fixture, not a live probe run. The decision logged in the commit:

> "Artifact disposition (user decision, 2026-06-09): the fixture-derived event was deleted after recording. docs/drift-events/ is real telemetry the future Signal-gate aggregation will read; a synthetic fixture reading (33% drift) stays out of it so the aggregation never needs a fixture-filtering rule."

## Guidance

Record the evidence that the capture code works (e.g., a trial block in the test file, a fixture snapshot assertion) and delete the synthetic artifact from the real telemetry directory before closing the PR.

Never leave a fixture-derived artifact in a directory that a downstream aggregation reads as real signal. If the test needs to assert the artifact was produced correctly, write it to a temp path or assert its structure in-memory — not to the production telemetry directory.

The check is: **would a future consumer of this directory need to know this file is synthetic in order to skip or discount it?** If yes, the file does not belong there.

## Why This Matters

**Every future consumer inherits the contamination problem.** A synthetic artifact sitting in a real telemetry directory means every aggregation, sweep, or report that reads that directory either:

- silently aggregates the fake reading (biasing rates and averages), or
- must grow a fixture-filtering rule to skip it.

Neither outcome is free. The first introduces invisible bias — a 33% synthetic drift rate inflates the real rate with no signal value. The second creates ongoing maintenance: the filter rule must be taught to every current and future consumer of the directory, and it drifts silently when filenames or frontmatter change.

Deleting the artifact after recording the test evidence costs one deletion. Not deleting it costs an unbounded filtering tax on every downstream reader.

## When to Apply

- Any test that exercises a commit-to-disk code path for telemetry or other aggregated records
- Any fixture run that writes to a directory used as a real data source by other skills or scripts
- Reviewing a PR that adds or extends telemetry capture tests — check the artifact disposition before approving

## Examples

Wrong — synthetic artifact left in production telemetry directory:

```
# test run completes, file remains
docs/drift-events/2026-06-09-test-fixture-run-3f2a.md   # looks like real telemetry
                                                          # future aggregation reads it
                                                          # 33% drift rate now inflated
```

Right — evidence recorded in the test file, artifact deleted:

```ts
// tests/work-vs-plan-workflow-eval.test.ts (commit 379d133)
// Trial block records what the capture produced:
//   drift rate: 33% (3 of 9 IUs drifted)
//   artifact schema: valid
//   disposition: deleted — docs/drift-events/ is real telemetry

// Artifact asserted then cleaned up:
expect(artifact.data.drifted.length).toBe(3)
expect(artifact.data.attempted.length).toBe(9)
// file removed before commit — aggregation never sees it
```

## Related

- `docs/solutions/skill-design/machine-telemetry-outside-human-learnings-corpus.md` — adjacent concern: where real telemetry lives relative to the human-learnings corpus; this doc is about keeping *synthetic/test-run* artifacts out of the real telemetry directory
- `docs/solutions/skill-design/capture-gate-avoid-selection-bias.md` — which real runs to capture (the complement: what belongs in the directory); this doc is about what must not enter it
- `docs/drift-events/README.md` — explains the directory purpose and the deferred Signal-gate aggregation that reads it
- Introduced by user decision in commit 379d133 (PR #14)
