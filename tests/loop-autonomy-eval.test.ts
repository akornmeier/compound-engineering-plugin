import path from "node:path"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"

// U8 — pre-committed acceptance gate for the autonomy agreement experiment.
//
// THE BAR IS FIXED BEFORE THE FIRST RUN (ADR 0001 pre-commitment discipline,
// following the tests/learning-sweep-eval.test.ts precedent): the PENDING
// block at the bottom of this file records the experiment's pass/fail bar
// verbatim from the origin brainstorm. Thresholds are committed here before
// any trial runs and are never adjusted mid-experiment
// (docs/solutions/skill-design/safe-auto-rubric-calibration.md).
//
// USER SIGN-OFF REQUIRED BEFORE THE FIRST TRIAL: the proposed thresholds and
// N below were set during U8 implementation. They have NOT been confirmed by
// explicit user sign-off in this execution session. Before running the first
// trial, the user must review the PENDING block, confirm or adjust the
// proposed values, and record that decision here. Threshold adjustment is
// permitted NOW (pre-trial) and prohibited after the first trial begins.
//
// TWO LAYERS, split by determinism (mirroring the precedent file):
//   1. Deterministic, exact-assertable here: the bar text in this file IS
//      substring-anchored to the origin doc's autonomy-agreement success
//      criterion (assertions below verify the origin doc contains the anchored
//      strings), and the terminal-line vocabulary the trials will record is
//      pinned to the skill's current wording.
//   2. The model-mediated autonomous-mode runs themselves are NOT assertable
//      in `bun test`. They are the recorded live trials — the acceptance gate
//      whose results replace the PENDING block below.

const ORIGIN =
  "docs/brainstorms/2026-06-12-loop-system-capture-closure-requirements.md"
const SKILL =
  "plugins/compound-engineering/skills/ce-learning-sweep/SKILL.md"

const originText = readFileSync(path.join(process.cwd(), ORIGIN), "utf8")
const skillText = readFileSync(path.join(process.cwd(), SKILL), "utf8")

// ---------------------------------------------------------------------------
// The pre-committed bar, substring-anchored to the origin doc's Success
// Criteria section.
//
// The origin's autonomy-agreement success criterion reads:
//   "Autonomy agreement gate (pre-committed before its first run):
//    autonomous-mode gate decisions are compared against human keep/reject
//    decisions on the same sweeps for an agreement experiment whose bar is
//    fixed in a committed artifact before the first trial; autonomy is
//    documented as recommended only after passing. Bar values are set when
//    the experiment is defined, not after seeing output."
//
// Each BAR constant below must appear verbatim in the origin doc (asserted
// below). This is the "machine-checked, not claimed" guarantee the precedent
// establishes.
// ---------------------------------------------------------------------------

const BAR = {
  // The core definition of the gate — the anchor phrase from the origin's
  // Success Criteria section.
  autonomyAgreementGate:
    "autonomous-mode gate decisions are compared against human keep/reject decisions on the same sweeps for an agreement experiment whose bar is fixed in a committed artifact before the first trial",

  // The recommendation condition — autonomy earns the recommended label only
  // after the gate passes.
  recommendedOnlyAfterPassing:
    "autonomy is documented as recommended only after passing",

  // The pre-commitment discipline — bar values are fixed before output is seen.
  barValuesPreCommitted:
    "Bar values are set when the experiment is defined, not after seeing output",
}

// Protocol conditions the experiment must hold, anchored to the origin doc's
// Key Decisions and Requirements sections.
const PROTOCOL = {
  // R3: explicit gate graduation discipline — an edge moves manual → automatic
  // only after passing a pre-committed signal gate.
  signalGateDiscipline:
    "An edge moves from manual to automatic only after passing a pre-committed signal gate",

  // The safety/quality distinction — content pre-conditions are independent of
  // the agreement gate and prior to the experiment.
  autonomyIsOptIn:
    "Autonomy is opt-in per run or per explicit configuration — never inherited",
}

// ---------------------------------------------------------------------------
// Autonomous-mode terminal-line vocabulary pinned to the skill's current
// wording.
//
// These are the exact terminal lines a trial's record will cite. Pinning them
// here means terminal-wording drift in the skill fails CI and unanchors
// recorded trial results. Per the precedent: "if the template's fixed wording
// drifts before adjudication, the recorded results become unanchored."
// ---------------------------------------------------------------------------

// The three autonomous-mode terminal outcomes (from Phase 7, autonomous flow):
const AUTONOMOUS_TERMINAL_LINES = {
  // Successful merge: entries entered the corpus.
  captured: "status: captured — ",

  // Checks red or watch timeout — PR waits, never auto-closed.
  stagedAwaitingAttention: "status: staged — awaiting attention",

  // Already-swept short-circuit (headless and autonomous share this).
  alreadySwept: "status: skipped — already swept",
}

// ---------------------------------------------------------------------------
// Deterministic assertions — run green today
// ---------------------------------------------------------------------------

describe("the pre-committed bar is substring-anchored to the origin doc's Success Criteria", () => {
  test.each(Object.entries(BAR))(
    "%s criterion is present in the origin doc",
    (_name, text) => {
      expect(originText).toContain(text)
    },
  )

  test.each(Object.entries(PROTOCOL))(
    "%s protocol condition is present in the origin doc",
    (_name, text) => {
      expect(originText).toContain(text)
    },
  )
})

describe("the autonomous-mode terminal-line vocabulary is pinned to the skill", () => {
  // The recorded trials cite these terminal lines; if the skill's wording
  // drifts before adjudication, the recorded results become unanchored.
  test("captured terminal line", () => {
    expect(skillText).toContain(AUTONOMOUS_TERMINAL_LINES.captured)
  })

  test("staged-awaiting-attention terminal line", () => {
    expect(skillText).toContain(AUTONOMOUS_TERMINAL_LINES.stagedAwaitingAttention)
  })

  test("already-swept terminal line", () => {
    expect(skillText).toContain(AUTONOMOUS_TERMINAL_LINES.alreadySwept)
  })
})

describe("this file's PENDING block contains the required structural elements", () => {
  const thisFile = readFileSync(
    path.join(process.cwd(), "tests/loop-autonomy-eval.test.ts"),
    "utf8",
  )

  test("PENDING status marker is present", () => {
    expect(thisFile).toContain("STATUS: PENDING")
  })

  test("user sign-off requirement is stated", () => {
    expect(thisFile).toContain("USER SIGN-OFF REQUIRED")
  })

  test("no-mid-experiment-adjustment rule is stated", () => {
    expect(thisFile).toContain("never adjusted mid-experiment")
  })

  test("content-pre-conditions safety disclaimer is present", () => {
    expect(thisFile).toContain("content pre-conditions")
  })

  test("experimental opt-in language is present until gate passes", () => {
    expect(thisFile).toContain("experimental opt-in")
  })

  test("agreement rate metric is named", () => {
    expect(thisFile).toContain("agreement rate")
  })

  test("false-keeps metric is named", () => {
    expect(thisFile).toContain("false-keeps")
  })
})

// ===========================================================================
// AUTONOMY AGREEMENT EXPERIMENT — acceptance gate: PENDING
// ===========================================================================
//
// STATUS: PENDING — no trials have run. This block was committed during U8
// implementation (2026-06-12) per the ADR 0001 pre-commitment discipline and
// the tests/learning-sweep-eval.test.ts precedent.
//
// USER SIGN-OFF REQUIRED BEFORE THE FIRST TRIAL:
//   The proposed thresholds and N below were proposed at implementation time.
//   Before the first trial runs, the user must explicitly confirm (or adjust)
//   these values and record that confirmation here. Post-trial adjustment is
//   not permitted. This execution session could not collect that sign-off.
//
// WHAT THIS GATE MEASURES (decision quality only):
//   This gate measures whether the autonomous mode's keep/reject decisions
//   agree with human judgments on the same sweeps. It governs the
//   RECOMMENDATION of autonomous mode — not its safety.
//
//   The autonomous mode's content pre-conditions (the validate-staged-keepers.py
//   allowlist: staged diff may touch only docs/solutions/**/*.md; slugs must be
//   traversal-safe; per-entry and per-PR diff sizes are capped) are HARD SAFETY
//   REQUIREMENTS independent of and prior to this experiment. Those pre-conditions
//   apply regardless of experiment outcome.
//
//   Until this gate passes, docs must describe mode:autonomous as experimental
//   opt-in, not recommended. The description frontmatter already carries this
//   framing; it must not change to "recommended" before a PASS adjudication is
//   recorded here.
//
// EXPERIMENT SHAPE:
//   - Run N sweeps with both modes active: one autonomous run per PR (gate
//     decisions recorded — keep / reject / near-miss per keeper with anchor)
//     and one human keep/reject pass on the same keepers from the same sweep.
//   - Measure two metrics:
//     (a) Agreement rate: fraction of keeper-level decisions where autonomous
//         and human agree on keep vs. reject (near-misses counted as reject for
//         this metric; already-documented keepers excluded — they are hard-gated
//         out by both paths).
//     (b) False-keeps of already-documented ground: keepers the autonomous
//         gate approved that the human or corpus-check subsequently identified
//         as already-documented. Zero tolerance.
//
// PROPOSED THRESHOLDS (REQUIRE USER SIGN-OFF — see above):
//   - N >= 5 sweeps across distinct merged PRs (matching the five-PR precedent
//     in tests/learning-sweep-eval.test.ts that authorized the trigger and
//     write-execution edges).
//   - Minimum 3 keepers total across the arm (to make agreement rate
//     non-trivially small-N; if N=5 sweeps yield <3 keepers total, extend N
//     until >= 3 keepers are accumulated).
//   - Agreement rate >= 80% on keep/reject per keeper.
//   - False-keeps of already-documented ground: 0 (zero tolerance, matching
//     the five-PR experiment's corpus-accuracy criterion — "already-documented
//     ground is correctly marked as such, never re-proposed as new").
//   - Variance-aware adjudication: where autonomy and human disagree on
//     a single keeper, record the disagreement and the anchor; a disagreement
//     on an anchor-75 near-call is less damning than a disagreement on an
//     anchor-100 keeper. Adjudicator should inspect the disagreement distribution,
//     not just the rate (per safe-auto-rubric-calibration.md methodology).
//
// RATIONALE FOR PROPOSED THRESHOLDS:
//   - N=5 matches the precedent experiment's trial count — the same count that
//     sufficed to authorize trigger and write-execution edges, which have similar
//     judgment complexity (sweep quality is the common factor; the new question
//     is only whether the gate substitutes correctly for the human).
//   - 80% agreement is the floor named in the origin doc's autonomy-agreement
//     success criterion's spirit: the gate must demonstrably replicate human
//     judgment. Below 80%, the gate would reject entries a human would keep (or
//     vice versa) too often to be a useful stand-in. Exact value proposed here;
//     user may adjust before sign-off.
//   - Zero false-keeps is non-negotiable: a poisoned-but-plausible already-
//     documented entry re-entering the corpus is a corpus-integrity failure.
//     This matches the five-PR experiment's falsification criterion for corpus
//     accuracy.
//   - Thresholds are NEVER adjusted mid-experiment (ADR 0001,
//     safe-auto-rubric-calibration.md). Calibration (if warranted) happens
//     only after adjudication is recorded.
//
// EXECUTION PROTOCOL:
//   1. For each of the N PRs:
//      a. Run mode:autonomous; record the gate-decision table (all keepers with
//         anchor, keep/reject/near-miss outcome) from the PR body or terminal output.
//      b. Run the sweep interactively on the same PR; record the human's keep/reject
//         decision per keeper. The human has the same sweep report; the only
//         difference is who resolves the judgment point.
//   2. After all N PRs: compute agreement rate and false-keep count.
//   3. Adjudicate: PASS if agreement rate >= threshold AND false-keeps == 0.
//   4. Replace this PENDING block with the recorded trials and adjudication,
//      following the tests/learning-sweep-eval.test.ts format exactly.
//   5. After PASS adjudication: update the description frontmatter and docs to
//      reflect that mode:autonomous is recommended (not just experimental opt-in).
//
// ===========================================================================
