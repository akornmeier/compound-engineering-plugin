---
title: Per-run machine telemetry lives outside the human-learnings corpus
date: 2026-06-10
category: skill-design
module: compound-engineering
problem_type: architecture_pattern
component: documentation
severity: medium
applies_when:
  - Adding a new class of machine-generated, per-run artifact (telemetry, probe records, run results) that gets committed to the repo
  - Choosing where a skill's durable output should live relative to docs/solutions/
  - Designing or modifying skills that sweep or search the docs/solutions/ corpus (ce-learnings-researcher, ce-compound-refresh)
tags:
  - telemetry
  - knowledge-corpus
  - docs-solutions
  - drift-events
  - directory-layout
  - scope-by-construction
  - ce-verify-work
---

# Per-run machine telemetry lives outside the human-learnings corpus

## Context

PR #13 (commit 22674e8) gave `ce-verify-work` a durable output: one committed drift-event file per qualifying probe run, recording which Implementation Units drifted or were attempted. These are committed markdown files about repo work, so `docs/solutions/` looked like a natural home.

But two skills treat everything under `docs/solutions/` as human institutional knowledge:

- `ce-learnings-researcher` searches it for past learnings during pre-work research
- `ce-compound-refresh` audits everything under it (excluding only the README) as keep/update/delete candidates

A drift event is per-run machine telemetry, not a human-authored learning. As `docs/drift-events/README.md` puts it: "These are not human-authored learnings. They are per-run telemetry, not institutional knowledge."

## Guidance

Keep per-run machine telemetry out of `docs/solutions/`. Give it a dedicated top-level directory — drift events live in `docs/drift-events/` — so the knowledge-sweeping skills never see it.

From the drift-event contract (`plugins/compound-engineering/skills/ce-verify-work/references/drift-event-contract.md`, Location section):

> housing it under `docs/solutions/` would surface every event as a false "past learning" in pre-work research and as a keep/update/delete candidate in refresh sweeps. A dedicated top-level directory keeps telemetry out of both skills' scope by construction — no exclusion list to maintain.

The general rule when introducing any committed machine-generated, per-run artifact class:

1. Identify which skills sweep, search, or audit candidate parent directories — and what they assume about the files there.
2. If the artifact violates those assumptions (machine-read vs human-authored, per-run vs durable), place it in its own directory outside their scope. Prefer separation **by construction** over exclusion lists — an exclusion list is configuration that must be maintained in every consuming skill and silently drifts.
3. Keep the artifact's frontmatter contract separate too. Drift events deliberately use a minimal drift-event frontmatter, not the ce-compound solution schema — sharing the corpus schema would make telemetry look even more like a learning to anything that parses frontmatter.

## Why This Matters

If telemetry lands in the corpus, the cost recurs on every run and every sweep:

- **Pre-work research degrades.** `ce-learnings-researcher` surfaces each event as a false "past learning," burying real institutional knowledge in run noise.
- **Refresh sweeps inflate.** `ce-compound-refresh` audits every event as a keep/update/delete candidate — wasted tokens at best, a maintenance pass rewriting or deleting telemetry at worst.
- **Exclusion lists drift.** The alternative — teaching each sweeping skill to skip telemetry — adds a list that every current and future consumer must maintain. By-construction separation requires no maintenance and protects skills that don't exist yet.

## When to Apply

- A skill or automation is about to write committed, per-run output and needs a home for it
- Reviewing a PR that adds machine-generated files under `docs/solutions/` (or any directory another skill sweeps wholesale)
- Adding a new corpus-sweeping skill and deciding what its scope should include

## Examples

Wrong — telemetry inside the corpus, requiring exclusion lists in every sweeping skill:

```
docs/solutions/telemetry/2026-06-09-plan--run-3f2a.md   # swept by ce-learnings-researcher
                                                        # audited by ce-compound-refresh
```

Right — dedicated top-level directory, out of scope by construction:

```
docs/drift-events/2026-06-09-001-feat-plan--run-3f2a.md  # neither skill searches or sweeps this directory
docs/drift-events/README.md                              # explains the directory to humans
```

## Related

- `plugins/compound-engineering/skills/ce-verify-work/references/drift-event-contract.md` — full drift-event document contract; its Location section states this rule
- `docs/drift-events/README.md` — directory purpose and the deferred aggregation that reads it
- `docs/adr/0001-per-metric-signal-gate.md` — why events store cited unit lists, never a derived rate
- `docs/solutions/skill-design/discoverability-check-for-documented-solutions.md` — complementary corpus-health concern (making the human corpus discoverable, where this doc keeps non-corpus files out of it)
- Introduced in commit 22674e8 (PR #13)
