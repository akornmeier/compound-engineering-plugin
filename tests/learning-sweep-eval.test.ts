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
// FIVE-PR VALIDATION EXPERIMENT — acceptance gate: PENDING
// ===========================================================================
//
// STATUS: PENDING — no experiment run has executed yet. U6 replaces this block
// with recorded trial results and an explicit adjudication
// (pass / fail / falsified). Pending semantics: this block records the bar; it
// must never fail CI.
//
// EXPERIMENT: sweep the five most recent merged PRs of this repo with
// /ce-learning-sweep (one PR per run), including PR #13 and PR #14.
//
// THE BAR (verbatim from the origin doc, asserted above):
//   - Yield: at least 2 keep-worthy, never-captured candidates across the
//     five PRs.
//   - Precision: noise no worse than ~1 discarded candidate per keeper — the
//     report must read as signal, not a list to triage.
//   - Corpus accuracy: already-documented ground is correctly marked as such,
//     never re-proposed as new.
//
// PROTOCOL CONDITIONS for a run to count:
//   - Forge access required: all five runs execute with review threads
//     available. A degraded run (threads inaccessible) does not count toward
//     the experiment.
//   - Known-answer probe: PR #13 must surface the fixture-telemetry
//     disposition decision as a keeper (ground truth: verified absent from
//     docs/solutions/ as of 2026-06-09; expected verdict: new).
//   - Negative control: PR #14 (comment-only trial record) — zero yield is
//     the correct output, not a result that counts against the bet.
//   - Report-only contract: each run writes nothing to the repo (clean
//     `git status` after every run).
//
// FALSIFICATION CLAUSE: zero keep-worthy yield across all five PRs falsifies
// the capture-bottleneck claim for this corpus and deprioritizes full B0 —
// the experiment is designed to be able to fail.
//
// RECORDING FORMAT (what U6 writes in place of this PENDING block), per PR:
//   - PR number, terminal status line as emitted
//   - candidates with anchors and verdicts (keepers, near-misses, discard count)
//   - user keep/reject judgment per keeper, against the bar
//   - any sweep-vs-ce-compound verdict disagreement observed when a keeper is
//     hand-routed through /ce-compound (recorded as a precision data point)
//   - clean-git-status check result
// Then: the adjudication — pass / fail / falsified — with the per-criterion
// readings. The bar is NOT adjusted mid-experiment; threshold tuning happens
// only after adjudication (safe-auto-rubric-calibration.md).
//
// ===========================================================================
