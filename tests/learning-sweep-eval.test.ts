import path from "node:path"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"

// U5 — pre-committed acceptance gate for the ce-learning-sweep five-PR
// validation experiment.
//
// THE BAR IS FIXED BEFORE THE FIRST RUN (ADR 0001 pre-commitment discipline,
// following the ce-verify-work precedent in work-vs-plan-workflow-eval.test.ts,
// commit 379d133): the PENDING block at the bottom of this file records the
// experiment's pass/fail bar verbatim from the origin brainstorm. U6 replaces
// the PENDING block with recorded trial results; the bar itself is never
// relitigated after seeing output, and thresholds are not adjusted
// mid-experiment (tuning happens after adjudication, per
// docs/solutions/skill-design/safe-auto-rubric-calibration.md).
//
// TWO LAYERS, split by determinism (mirroring the precedent file):
//   1. Deterministic, exact-assertable here: the bar text in this file IS the
//      origin doc's Success Criteria (substring assertions below — "verbatim"
//      is machine-checked, not claimed), and the terminal-line vocabulary the
//      trials will record is fixed in the skill's report template.
//   2. The model-mediated sweep runs themselves are NOT assertable in
//      `bun test`. They are the five recorded live trials — the acceptance
//      gate whose results replace the PENDING block below.

const ORIGIN = "docs/brainstorms/2026-06-09-batch-learning-capture-requirements.md"
const REPORT_TEMPLATE =
  "plugins/compound-engineering/skills/ce-learning-sweep/references/report-template.md"

const originText = readFileSync(path.join(process.cwd(), ORIGIN), "utf8")
const templateText = readFileSync(path.join(process.cwd(), REPORT_TEMPLATE), "utf8")

// The pre-committed bar, verbatim from the origin doc's Success Criteria.
const BAR = {
  yield:
    "**Yield:** at least 2 keep-worthy, never-captured candidates across the five PRs.",
  precision:
    "**Precision:** noise no worse than ~1 discarded candidate per keeper — the report must read as signal, not a list to triage.",
  corpusAccuracy:
    "**Corpus accuracy:** already-documented ground is correctly marked as such, never re-proposed as new.",
  falsification:
    "**Falsification clause:** zero keep-worthy yield across all five PRs falsifies the capture-bottleneck claim for this corpus and deprioritizes full B0 — the experiment is designed to be able to fail.",
}

// Protocol conditions for the runs to count, verbatim anchors from the origin.
const PROTOCOL = {
  forgeAccess:
    "**Forge access required.** All five experiment runs execute with review threads available.",
  knownAnswer:
    "**Known-answer probe:** PR #13 contains a ground-truth uncaptured learning — the fixture-telemetry disposition decision (verified absent from `docs/solutions/` as of 2026-06-09). A sweep that misses it is missing real signal.",
  negativeControl:
    "**Negative control:** PR #14 is a comment-only trial record; zero yield on it is the correct output, not a result that counts against the bet.",
}

describe("the pre-committed bar matches the origin doc's Success Criteria verbatim", () => {
  test.each(Object.entries(BAR))("%s criterion is verbatim from the origin", (_name, text) => {
    expect(originText).toContain(text)
  })

  test.each(Object.entries(PROTOCOL))(
    "%s protocol condition is verbatim from the origin",
    (_name, text) => {
      expect(originText).toContain(text)
    },
  )
})

describe("the report vocabulary the trials will record is fixed in the template", () => {
  // The recorded trials cite these terminal lines; if the template's fixed
  // wording drifts before adjudication, the recorded results become
  // unanchored. Pin the three lines the experiment depends on.
  test("candidates terminal line", () => {
    expect(templateText).toContain(
      "status: swept — <K> keeper(s), <M> near-miss(es), <D> discarded",
    )
  })

  test("clean no-candidates terminal line (negative-control target)", () => {
    expect(templateText).toContain("status: swept clean — no candidate learnings")
  })

  test("skipped terminal line", () => {
    expect(templateText).toContain("status: skipped — <reason>")
  })
})

// ===========================================================================
// FIVE-PR VALIDATION EXPERIMENT — acceptance gate: RECORDED
// ===========================================================================
//
// STATUS: RECORDED — five trials executed 2026-06-10, adjudicated by the user
// the same day. The bar below was committed before the first run (commit
// 5f9a236) and was not adjusted mid-experiment.
//
// THE BAR (verbatim from the origin doc, asserted above):
//   - Yield: at least 2 keep-worthy, never-captured candidates across the
//     five PRs.
//   - Precision: noise no worse than ~1 discarded candidate per keeper — the
//     report must read as signal, not a list to triage.
//   - Corpus accuracy: already-documented ground is correctly marked as such,
//     never re-proposed as new.
//
// EXECUTION: each trial ran the skill from source via subagent injection
// (plugin skill content caches at session start, per AGENTS.md), one fresh
// agent per PR, live gh against this repo. Corpus at 31 docs for all runs.
//
// RECORDED TRIALS (PR | run_id | terminal line | keepers / near-misses / discards):
//
//   | PR  | run_id                    | terminal status line                              | K | M | D |
//   |-----|---------------------------|---------------------------------------------------|---|---|---|
//   | #14 | 20260610-075926-ba870b05  | status: swept — 1 keeper(s), 1 near-miss(es), 3 discarded | 1 | 1 | 3 |
//   | #13 | 20260610-075928-ba2bc67e  | status: swept — 5 keeper(s), 4 near-miss(es), 3 discarded | 5 | 4 | 3 |
//   | #12 | 20260610-075937-9aed3d2b  | status: swept — 3 keeper(s), 2 near-miss(es), 1 discarded | 3 | 2 | 1 |
//   | #11 | 20260610-075938-b42211b9  | status: swept — 2 keeper(s), 2 near-miss(es), 1 discarded | 2 | 2 | 1 |
//   | #10 | 20260610-075943-0ab682be  | status: swept — 2 keeper(s), 4 near-miss(es), 3 discarded | 2 | 4 | 3 |
//
//   Totals: 13 keepers (7 new, 2 overlaps-existing, 4 already-documented),
//   13 near-misses, 11 counted discards. Anchors: 10 keepers at 100, 3 at 75.
//   Keepers by PR:
//     #14: synthetic-fixture-artifacts-out-of-telemetry-dirs (100/new)
//     #13: deterministic-projection-LLM-copies-verbatim (100/overlaps-existing);
//          sort-model-output-by-stable-key (100/new); telemetry-outside-
//          docs-solutions (100/new); workflow-runtime-cannot-mint-dates
//          (100/overlaps-existing); bias-aware-telemetry-write-gates (75/new)
//     #12: live-boundary contracts 4/5/N>=3-range — all three correctly
//          verdicted already-documented against the very doc the PR edited
//          (5/5 dimensions cited), no routing blocks, none re-proposed as new
//     #11: plan-Files-block-path-shape-filter (100/new);
//          extensionless-file-allowlist-for-path-heuristics (100/new)
//     #10: live-boundary-contract-cluster (100/already-documented);
//          single-source-deterministic-core-with-build-time-inlining (75/new)
//
// PROTOCOL CONDITIONS — all held on every trial:
//   - Forge access: all five envelopes returned status ok with NO
//     degraded_inputs flag (review threads fetched live). Every run counted.
//   - Report-only: `git status` clean after every run; the only filesystem
//     footprint was /tmp scratch.
//   - Sweep-vs-ce-compound disagreements: none observed — no keeper was
//     routed through /ce-compound during the experiment window (hand-routing
//     is post-experiment follow-up; disagreements there are future data).
//
// KNOWN-ANSWER PROBE & NEGATIVE CONTROL — adjudicated together (user,
// 2026-06-10): the ground-truth "fixture-telemetry disposition decision" was
// expected on PR #13 with PR #14 as a zero-yield negative control. The
// decision's evidence text actually lives in #14's diff (the recorded
// trial-record comment block, commit 379d133), and the sweep surfaced it
// there verbatim as an anchor-100 keeper verdicted new. Adjudication: HIT —
// the origin doc mis-attributed the location; the negative control was
// compromised by design (it was never a zero-signal PR), recorded as a
// control-design finding, not a sweep failure. PR #13 independently yielded
// five defensible keepers.
//
// ADJUDICATION (user, 2026-06-10): **PASS**.
//   - Yield: PASS — 9 never-captured keepers (7 new + 2 overlaps-existing);
//     user confirmed >= 2 keep-worthy.
//   - Precision: PASS under the discards-only reading (11 discards / 13
//     keepers ~= 0.85 per keeper, within the ~1 bar). The near-miss tier
//     (13 one-liners) is deliberate tuning data, not triage burden; recorded
//     here so a future threshold retune can revisit the reading.
//   - Corpus accuracy: PASS — 4 already-documented keepers correctly cited
//     their covering doc with 5/5 matched dimensions; zero already-documented
//     ground re-proposed as new (PR #12 was the hardest case: a capture PR
//     swept against the very doc it created).
//   - Falsification clause: NOT triggered.
//
// Threshold tuning, if any, happens now that adjudication is recorded
// (safe-auto-rubric-calibration.md) — candidate: whether near-misses belong
// in the precision denominator, and whether keeper volume on large feature
// PRs (5 on #13) warrants a per-PR keeper cap. Neither changes this result.
//
// ===========================================================================
