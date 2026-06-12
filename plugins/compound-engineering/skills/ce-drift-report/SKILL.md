---
name: ce-drift-report
description: "Aggregate all drift events in docs/drift-events/ and report per-plan and cross-plan drift rates derived at read time. Use after running ce-verify-work on one or more plans to see rework-rate signal across accumulated probe runs."
allowed-tools: Bash(python3 *scan-drift-events.py), Read, Grep
---

# Drift Report

Aggregate the committed drift events in `docs/drift-events/` and render a read-time rate report. This is a **report-only probe**: it writes nothing, stores no rates, and has no judgment points or modes. Rates are always derived as `|drifted| / |attempted|` at the moment the script runs — ADR 0001 forbids storing precomputed rates.

**Relationship to `ce-verify-work`:** that skill is the producer; each qualifying probe run it completes appends one event file to `docs/drift-events/`. This skill is the reader.

## Step 1: Locate the repo root and run the aggregator

Resolve the repo root so the script finds `docs/drift-events/` regardless of CWD:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
python3 "${CLAUDE_SKILL_DIR:-.}/scripts/scan-drift-events.py" "$REPO_ROOT/docs/drift-events"
```

The script emits one JSON envelope to stdout and exits 0 for all recognized states. Branch on the envelope's top-level `status`:

| `status` | Meaning | Action |
|---|---|---|
| `ok` | Events scanned; rates derived | Render the report per `references/report-template.md` |
| `no_drift_data` | No event files found or directory absent | Render the "no drift data yet" variant from the template |

## Step 2: Render the report

Read `references/report-template.md` and render the appropriate variant based on the envelope `status`. Emit the report in chat — nothing is written to the repo.
