# Report template

The report is chat-only — nothing is written to the repo. Render the sections in the order below. The three terminal status lines at the bottom are **fixed wording**; emit exactly one, verbatim, as the final line so callers can machine-detect the outcome (following the `status:` / `Documentation complete` envelope precedent).

## Header (every report)

```
Learning sweep — PR #<number> (<repo>)
Run: <run-id>

Inputs:
- Degraded: <none | review_threads inaccessible — swept on diff + commits>
- Truncations: <none | diff capped | threads capped | diff + threads capped>
- Exclusions: <none | N lockfile/generated paths dropped from the diff>
- Corpus: <N docs indexed | empty corpus — every candidate verdicts new> [| M doc(s) skipped: malformed frontmatter]
```

Populate `Degraded` from `flags.degraded_inputs`, `Truncations` from `flags.truncations`, `Exclusions` from the length of `flags.excluded_paths`, and `Corpus` from the scan-corpus index length and `warnings`.

## Keeper entries (anchor >= 75)

One block per keeper, in descending anchor order:

```
### Keeper: <short learning name>

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
