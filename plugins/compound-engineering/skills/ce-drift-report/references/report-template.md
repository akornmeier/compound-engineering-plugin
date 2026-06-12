# Drift report template

Render the appropriate variant below based on the envelope `status`. The terminal status line is **fixed wording** — emit exactly one, verbatim, as the final line so callers can machine-detect the outcome.

---

## Variant A — `status: ok` (events found)

```
Drift report
Events scanned: <N>  |  Warnings: <W>  |  Flagged (low-confidence or degraded): <F>
```

### Per-plan table

| Plan | Events | Attempted | Drifted | Rate | Flags |
|---|---|---|---|---|---|
| `<plan-basename>` | <N> | <attempted> | <drifted> | <rate or n/a> | <flags or —> |

One row per plan key in `per_plan`. For `rate`: format as a decimal to 2 places (e.g. `0.33`) when `rate` is not null; use `n/a` when null (all events for this plan had `attempted: []`). For `flags`: list `low-confidence` and/or `degraded` when `flagged > 0`; use `—` otherwise.

### Cross-plan aggregate

```
All plans: <events> event(s), <attempted> attempted units, <drifted> drifted — rate <rate or n/a>
Flagged runs: <F>
```

Flagged runs are included in all counts. If `flagged_count > 0`, add a note:
```
Note: <F> run(s) flagged as low-confidence or degraded — rates include these readings.
```

### Terminal status line

```
status: drift report — <N> event(s) across <P> plan(s), cross-plan rate <rate or n/a>
```

Where `<P>` is the count of distinct plan keys in `per_plan`.

---

## Variant B — `status: no_drift_data` (zero events or directory absent)

```
Drift report
No drift data yet.
```

If `events_dir_found` is false, add:
```
Events directory not found at: <events_dir>
```

If `events_dir_found` is true but `events_scanned` is 0, add:
```
No qualifying event files in: <events_dir>
```

If `warnings` is non-empty, list them:
```
Warnings:
- <file>: <reason>
```

### Terminal status line

```
status: no drift data yet
```

---

## Notes on flagged events

Low-confidence and degraded events are **never dropped** — they contribute to all counts and denominators. The `flagged_count` field and per-plan `flagged` column surface them for the reader's judgment. A flagged reading is a real reading; excluding it would silently bias the aggregate.

Warnings record files that could not be parsed. They do not affect the rate computation for parseable events.
