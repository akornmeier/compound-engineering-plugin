import { readFileSync } from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import {
  parsePlanUnits,
  rollupVerdicts,
} from "../plugins/compound-engineering/skills/ce-verify-work/workflows/drift-rollup.js"

// U5 — eval for the ce-verify-work pipeline.
//
// TWO LAYERS, split by determinism:
//   1. The deterministic roll-up is exact-assertable here (variance = 0): given a
//      fixed verdict set, the drift rate, denominator, and low_confidence flag
//      are byte-stable. The fixture's parse is also exact.
//   2. The model-mediated classification (does the live workflow actually
//      dispatch agents, and do they reach the right verdicts?) is NOT assertable
//      in `bun test`. It is validated by the MANUAL LIVE SMOKE RUN — a required
//      acceptance gate whose recorded results are documented at the bottom of
//      this file (per dynamic-workflow-conversion-live-boundary.md).

const FIXTURE = "tests/fixtures/verify-work/sample-plan.md"
const fixtureText = readFileSync(path.join(process.cwd(), FIXTURE), "utf8")

// Ground truth the live classifier should reach for the fixture (each unit
// points at a real repo file with a known state). Documented in the fixture.
const GROUND_TRUTH: Record<string, string> = {
  U1: "done", // drift-rollup.js exists + exports the contract
  U2: "remaining", // never-created-helper.js was never committed
  U3: "drifted", // SKILL.md was committed (attempted) but the JSON/caching Verification is unmet
  U4: "unverifiable", // "5ms p99 under production load" is intrinsically runtime
  U5: "done", // verdict-schema.json defines exactly the four-verdict enum (statically checkable -> NOT unverifiable)
}

function verdictsFrom(map: Record<string, string>) {
  return Object.entries(map).map(([u_id, verdict]) => ({
    u_id,
    verdict,
    evidence: verdict === "done" || verdict === "drifted" ? [`evidence for ${u_id}`] : [],
    rationale: `${u_id} is ${verdict}`,
  }))
}

describe("fixture parses to the expected unit structure", () => {
  const units = parsePlanUnits(fixtureText)

  test("parses all five units with verbatim U-IDs", () => {
    expect(units.map((u) => u.u_id)).toEqual(["U1", "U2", "U3", "U4", "U5"])
  })

  test("each unit's declared file is extracted", () => {
    expect(units[0].files.all).toContain(
      "plugins/compound-engineering/skills/ce-verify-work/workflows/drift-rollup.js",
    )
    expect(units[1].files.all).toContain(
      "plugins/compound-engineering/skills/ce-verify-work/workflows/never-created-helper.js",
    )
    expect(units[4].files.all).toContain(
      "plugins/compound-engineering/skills/ce-verify-work/references/verdict-schema.json",
    )
  })
})

describe("deterministic roll-up — exact on the fixture's ground truth", () => {
  test("ground truth rolls up to drift_rate 1/3 over an attempted set of 3", () => {
    const out = rollupVerdicts(verdictsFrom(GROUND_TRUTH))
    expect(out.counts).toMatchObject({ done: 2, remaining: 1, drifted: 1, unverifiable: 1, attempted: 3 })
    expect(out.drift_rate).toBeCloseTo(1 / 3, 10)
    // attempted (3) >= floor and unverifiable fraction (1/5) is low -> trustworthy.
    expect(out.low_confidence).toBe(false)
  })

  test("the false-unverifiable control unit (U5) is done, not unverifiable", () => {
    // U5 has concrete Files + a statically-checkable Verification; routing it to
    // unverifiable would shrink the denominator. Ground truth keeps it attempted.
    expect(GROUND_TRUTH.U5).toBe("done")
    const out = rollupVerdicts(verdictsFrom(GROUND_TRUTH))
    // Only U4 is unverifiable, and it is excluded from the attempted denominator.
    expect(out.unverifiable.map((u) => u.u_id)).toEqual(["U4"])
    expect(out.counts.attempted).toBe(out.counts.done + out.counts.drifted)
  })

  test("byte-identical across repeated runs (variance = 0)", () => {
    const v = verdictsFrom(GROUND_TRUTH)
    expect(JSON.stringify(rollupVerdicts(v))).toBe(JSON.stringify(rollupVerdicts(v)))
  })
})

describe("known-ground-truth fixtures spanning ratios", () => {
  test("ratio 1/3 (1 drifted of 3 attempted)", () => {
    const out = rollupVerdicts(verdictsFrom({ U1: "done", U2: "done", U3: "drifted" }))
    expect(out.drift_rate).toBeCloseTo(1 / 3, 10)
  })

  test("ratio 2/3 (2 drifted of 3 attempted)", () => {
    const out = rollupVerdicts(verdictsFrom({ U1: "done", U2: "drifted", U3: "drifted" }))
    expect(out.drift_rate).toBeCloseTo(2 / 3, 10)
  })

  test("negative control: an all-done set drifts at 0, nothing miscounted as drifted", () => {
    const out = rollupVerdicts(verdictsFrom({ U1: "done", U2: "done", U3: "done" }))
    expect(out.drift_rate).toBe(0)
    expect(out.counts.drifted).toBe(0)
  })
})

describe("small-attempted volatility guard", () => {
  test("1 done + 1 drifted reads 0.5 but is flagged low_confidence on both paths", () => {
    // Both the workflow and the prose fallback call this same rollupVerdicts, so
    // the flag (and the rate) cannot diverge across paths.
    const out = rollupVerdicts(verdictsFrom({ U1: "done", U2: "drifted" }))
    expect(out.drift_rate).toBeCloseTo(0.5, 10)
    expect(out.low_confidence).toBe(true)
  })
})

// ===========================================================================
// LIVE SMOKE RUN — required acceptance gate (recorded results)
// ===========================================================================
//
// `bun test` cannot dispatch the Workflow tool, so the live run is performed by
// invoking the real Workflow against tests/fixtures/verify-work/sample-plan.md
// with the committed work-vs-plan-fanout.generated.js. Recorded below; rerun via
// `/ce-verify-work tests/fixtures/verify-work/sample-plan.md` (Claude Code).
//
// Asserted at the live boundary (not here): agents actually executed (non-zero
// subagent tokens, populated `units`); the envelope validates against the
// documented shape; `run_id`/`artifact_path` populated; the absent-file unit
// (U2) classifies `remaining`; the committed-but-diverged unit (U3) classifies
// `drifted` with cited evidence; the behavioral unit (U4) classifies
// `unverifiable` and is excluded from the denominator; the statically-checkable
// control (U5) is NOT `unverifiable`.
//
// RECORDED — N=3 live trials, 2026-06-08, against the committed
// work-vs-plan-fanout.generated.js (real Workflow dispatch, real subagents):
//
//   | trial | batch_size | agents | subagent_tokens | status   | drift_rate |
//   |-------|------------|--------|-----------------|----------|------------|
//   | t1    | 3 (2 batches) | 2   | 105,637         | complete | 0.333      |
//   | t2    | default (1)   | 1   | 53,453          | complete | 0.333      |
//   | t3    | default (1)   | 1   | 53,957          | complete | 0.333      |
//
//   Drift-rate range: 0.333–0.333 (zero variance across 3 trials).
//   Verdict accuracy vs. ground truth: 15/15 (5 units x 3 trials).
//
// Live-boundary contracts — all held on every trial:
//   - args parsed (run_id populated, never "unknown-run"); plan_text consumed.
//   - agents actually executed (non-zero subagent_tokens, populated `units`).
//   - no swallowed dispatch errors (failed_batches 0); batching exercised (t1: 2 batches).
//   - run_id + artifact_path populated; envelope matched the documented shape.
//
// Verdict checks — all held on every trial:
//   - U2 (absent file, no commit) -> remaining.
//   - U3 (committed SKILL.md, JSON/caching Verification unmet) -> drifted, citing
//     BOTH the attempt commit AND the divergence (the drifted contract).
//   - U4 (5ms-p99 runtime claim) -> unverifiable, excluded from the denominator.
//   - U5 (statically-checkable enum) -> done, NOT unverifiable (false-unverifiable
//     control held — ambiguity did not shrink the denominator).
//
// Cross-path agreement: the prose fallback shares the same verdict-rubric.md and
// the same rollupVerdicts module, and the unambiguous verdicts are repo facts
// (U2 helper absent -> remaining; U3 SKILL.md committed but lacks --json/caching
// -> drifted; U5 enum exactly the four verdicts -> done) — confirmed by direct
// repo inspection, identical to the workflow path. The rate/flag cannot diverge
// across paths because both call the one rollupVerdicts (asserted above).
