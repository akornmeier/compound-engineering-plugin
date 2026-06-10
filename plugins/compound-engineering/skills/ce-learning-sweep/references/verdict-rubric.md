# Corpus verdict rubric

Assign each deduped candidate exactly one corpus verdict: `already-documented`, `overlaps-existing`, or `new`. The verdict measures how well the existing `docs/solutions/` corpus already covers the candidate. It is **advisory routing signal** — it tells the user how to route a keeper through `ce-compound`, nothing more.

## Shared definitions — `ce-compound` owns the boundary

The five dimensions and the High/Moderate/Low scale below are the **same** assessment `ce-compound`'s Related Docs Finder runs. The definitions are shared verbatim; the two skills may disagree on *judgment* for a given candidate, but never on *definitions*. **`ce-compound` is authoritative at write time** — when its own overlap check disagrees with this sweep's verdict during a capture, `ce-compound` wins. A disagreement is expected and is recorded as a precision data point, not treated as a bug here.

## The five dimensions

Score overlap between the candidate and a covering doc across these five dimensions, identically to `ce-compound`:

1. **Problem statement** — the candidate and the doc describe the same problem or situation.
2. **Root cause** — the same underlying cause or mechanism.
3. **Solution approach** — the same fix, pattern, or recommendation.
4. **Referenced files** — overlapping modules, files, or components.
5. **Prevention rules** — the same guidance for avoiding recurrence.

A dimension "matches" when the doc genuinely covers that aspect of the candidate, not merely shares a keyword. The index alone cannot settle this — read the shortlisted doc bodies before scoring.

## The scale and the verdict mapping

| Dimensions matched | Overlap | Verdict |
|--------------------|---------|---------|
| 4-5 | **High** — essentially the same learning already captured | `already-documented` |
| 2-3 | **Moderate** — same area, different angle or solution | `overlaps-existing` |
| 0-1 | **Low or none** — related but distinct, or no covering doc | `new` |

## Per-verdict evidence requirements

**`already-documented`** — the highest evidentiary bar.
- **Required:** cite the covering doc's `path` AND name which of the five dimensions matched (at least four). A bare "this is already documented" without the path and matched dimensions is not a valid `already-documented` verdict — downgrade to `overlaps-existing` or `new` until the evidence is in hand.
- Rendered as citation only: no routing block (the learning is already in the corpus).

**`overlaps-existing`** — the middle verdict.
- **Required:** name the **single best** covering doc (`path`) AND the 2-3 matched dimensions. Set the **extend-candidate flag** — this is a learning the corpus partially covers, a candidate for extending the existing doc rather than creating a new one.
- Rendered with a routing block that steers to `ce-compound`'s **Full mode**, naming the overlapping doc as context so `ce-compound` can decide create-vs-update-in-place.

**`new`** — no meaningful coverage.
- **Required:** no doc citation (there is none). When the corpus index is empty (missing or empty `docs/solutions/`), **every** candidate is `new` by definition — the run completes cleanly.
- Rendered with a full handoff block: a ready-to-use `ce-compound` invocation framing.

## Tie-break direction

When a candidate sits on a boundary between two verdicts (e.g. 3 vs 4 dimensions matched, or 1 vs 2), **break toward the lower-coverage verdict** — `new` over `overlaps-existing`, `overlaps-existing` over `already-documented`.

Rationale: the sweep is a *front-end* to capture, and `ce-compound` is authoritative at write time with its own overlap check. Under-claiming coverage routes the keeper to `ce-compound`, which will independently detect high overlap and update-in-place — a self-correcting path. Over-claiming coverage (a false `already-documented`) silently drops a real learning with **no** downstream check to catch the miss, because `already-documented` keepers carry no routing block. A dropped learning is the expensive error; a redundant routing is cheap. This mirrors `ce-verify-work`'s conservative tie-break: lean toward the call whose failure mode is recoverable.
