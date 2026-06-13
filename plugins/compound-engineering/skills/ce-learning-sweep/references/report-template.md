# Report template

The report is chat-only — nothing is written to the repo. Render the sections in the order below. The three terminal status lines at the bottom are **fixed wording**; emit exactly one, verbatim, as the final line so callers can machine-detect the outcome (following the `status:` / `Documentation complete` envelope precedent).

## Header (every report)

```
Learning sweep — PR #<number> (<repo>)
Run: <run-id>

Inputs:
- Degraded: <none | review_threads inaccessible — swept on diff + commits>
- Truncations: <none | diff capped | threads capped | thread comments capped | combinations>
- Exclusions: <none | N lockfile/generated paths dropped from the diff>
- Corpus: <N docs indexed | empty corpus — every candidate verdicts new | corpus directory not found at <path> — every candidate verdicts new> [| M doc(s) skipped: malformed frontmatter]
```

Populate `Degraded` from `flags.degraded_inputs`, `Truncations` from `flags.truncations`, `Exclusions` from the length of `flags.excluded_paths`, and `Corpus` from the scan-corpus index length and `warnings`. When scan-corpus reports `corpus_dir_found: false`, use the not-found variant and quote the scanned `corpus_dir` path rather than the empty-corpus variant.

## Keeper entries (anchor >= 75)

One block per keeper, in descending anchor order:

```
### Keeper: <short learning name>

ID: <keeper_id>
Anchor: <75 | 100>
Verdict: <new | overlaps-existing | already-documented>

Evidence:
- <review thread>  ->  <thread comment URL>
- <commit>         ->  <40-char SHA>
- <diff finding>   ->  <file/path.ext @ <hunk header or line range>>

Capture fuel:
- Learning: <one- or two-sentence transferable statement of the learning>
- Evidence excerpts:
  > <verbatim excerpt from the thread/commit/diff that grounds the learning>
- Suggested track/category: <plain-language suggestion, e.g. "knowledge track,
  workflow-issues" — a hint for ce-compound, NOT a schema field>

<verdict-conditional routing block — see below>
```

**Evidence pointer formats are fixed by source** — use the exact mapping:
- review thread -> the thread's comment URL
- commit -> the commit SHA
- diff finding -> file path plus a hunk reference (the `@@` header or nearest line range)

A merged candidate (intra-batch dedup) lists **all** contributing sources, each in its own line with its own pointer.

**Capture fuel must stand alone.** A `/ce-compound` run in a fresh session, with no other context, must be able to write the learning from the fuel block. State the learning, quote the grounding evidence, suggest a track/category in plain language. **Do not duplicate `ce-compound`'s `schema.yaml`** — the track/category line is a suggestion in prose; `ce-compound` owns the canonical frontmatter at write time.

### Verdict-conditional routing blocks

**`new`** — full handoff block:

```
Route: ready to capture. Run:
  /ce-compound — capturing the learning above
This is not covered by the existing corpus. ce-compound will create a new doc.
```

**`overlaps-existing`** — handoff steered to Full mode, overlapping doc named:

```
Route: extend candidate. Run ce-compound in Full mode:
  /ce-compound — extend <docs/solutions/.../overlapping-doc.md>
Matched dimensions: <list>. ce-compound's overlap check decides whether to
update that doc in place or create a new one — it is authoritative at write time.
```

**`already-documented`** — citation only, NO routing block:

```
Covered by: <docs/solutions/.../covering-doc.md>
Matched dimensions: <list>. Already in the corpus — no capture needed.
```

## Near-miss section (anchor 50)

One line per near-miss candidate — statement plus anchor, no capture fuel:

```
## Near misses (anchor 50 — real but minor)
- <one-line learning statement>  (50)
- <one-line learning statement>  (50)
```

Omit the section entirely when there are no anchor-50 candidates.

## Discard count line (below 50)

```
Discarded (anchor < 50, not learnings): <N>
```

Always emit this line (use `0` when none). It carries no per-candidate detail — only the count.

## Keeper envelope (`keepers.json`)

After rendering the report, write `keepers.json` to the run's scratch directory (only when at least one keeper exists):

```
/tmp/compound-engineering/ce-learning-sweep/<run-id>/keepers.json
```

The envelope is a JSON array — one object per keeper in `keeper_id` order. Required fields:

| Field | Type | Description |
|---|---|---|
| `keeper_id` | string | Stable per-run label in report order: `k1`, `k2`, ... |
| `anchor` | integer | 75 or 100 |
| `verdict` | string | `new`, `overlaps-existing`, or `already-documented` |
| `overlapping_doc` | string \| null | Path to overlapping doc when verdict is non-new; `null` otherwise |
| `capture_fuel` | string | Full capture-fuel text verbatim — learning statement, evidence excerpts, suggested track/category — exactly as rendered in the report. This is the blob `ce-compound mode:headless` consumes. |

Track/category stays a prose hint inside `capture_fuel`, never a separate structured field (do not duplicate `ce-compound`'s schema).

The report's keeper entries include `ID: <keeper_id>` so the report and envelope cross-reference by id.

## Terminal status lines (fixed wording — emit exactly one as the final line)

**Report with candidates** (one or more keepers and/or near-misses surfaced):
```
status: swept — <K> keeper(s), <M> near-miss(es), <D> discarded
```

**Clean no-candidates report** (the sweep ran fully and yielded nothing — AE5):
```
status: swept clean — no candidate learnings
```

**Skipped-with-reason** (Phase 1 short-circuited; no report body precedes this line):
```
status: skipped — <reason>
```

For the skipped line, `<reason>` names the Phase 1 cause: `PR not found`, `PR not merged (open)`, `PR not merged (draft)`, `PR not merged (closed, unmerged)`, `repo mismatch: <detail>`, `no forge access`, or `fetch failed: <detail>`.
