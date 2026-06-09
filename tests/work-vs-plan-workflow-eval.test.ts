import path from "node:path"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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
// DRIFT-EVENT CAPTURE — the writer-side projection + artifact contract (U1–U3)
// ===========================================================================
//
// The deterministic core is now real code (rollupVerdicts' grouped lists), so we
// assert against it directly. The artifact assembly is the SKILL.md Phase 4
// contract encoded as a test helper that mirrors references/drift-event-template.md
// — it proves the contract is satisfiable (parser-safe, key-complete, rate-free)
// given the deterministic lists. That the orchestrator's prose ACTUALLY emits this
// shape is the live-smoke gate, recorded below.

const FRONTMATTER_VALIDATOR = path.join(
  process.cwd(),
  "plugins/compound-engineering/skills/ce-compound/scripts/validate-frontmatter.py",
)

// A full ce-verify-work envelope: rollupVerdicts' output plus the workflow's
// outer fields (status, plan_path, run_id) the orchestrator reads in Phase 4.
function envelopeFrom(
  map: Record<string, string>,
  opts: { status?: string; plan_path: string; run_id: string },
) {
  const rolled = rollupVerdicts(verdictsFrom(map))
  return { status: opts.status ?? "complete", ...rolled, plan_path: opts.plan_path, run_id: opts.run_id }
}

// Phase 4's write gate: skip a contract-violating call (invalid_input) and a
// no-denominator run (attempted 0); capture everything else.
function shouldCapture(env: { status: string; counts: { attempted: number } }): boolean {
  return env.status !== "invalid_input" && env.counts.attempted > 0
}

// The Phase 4 assembly, encoding references/drift-event-contract.md +
// drift-event-template.md. Copies envelope.grouped verbatim — never a rate.
function assembleDriftEvent(
  env: ReturnType<typeof envelopeFrom>,
  opts: { today: string; planBasename: string },
): string {
  const g = env.grouped
  const fmt = (xs: string[]) => `[${xs.join(", ")}]`
  const evidence = env.units
    .filter((u) => u.verdict === "done" || u.verdict === "drifted")
    .map((u) => `- ${u.u_id} (${u.verdict}): ${u.evidence.join("; ")}`)
  return [
    "---",
    `date: ${opts.today}`,
    `plan: ${opts.planBasename}`,
    `run_id: ${env.run_id}`,
    "tags: [drift-event, work-vs-plan-verification, ce-verify-work]",
    "---",
    "",
    `# Drift event — ${opts.planBasename} (${env.run_id})`,
    "",
    "```yaml",
    "# machine-read block — copied verbatim from the envelope's grouped lists.",
    "# The aggregation reads THIS; the rate is derived, never stored.",
    `plan_path: ${env.plan_path}`,
    `run_id: ${env.run_id}`,
    `low_confidence: ${env.low_confidence}`,
    `degraded: ${env.status === "degraded"}`,
    `drifted: ${fmt(g.drifted)}`,
    `attempted: ${fmt(g.attempted)}`,
    `remaining: ${fmt(g.remaining)}`,
    `unverifiable: ${fmt(g.unverifiable)}`,
    "```",
    "",
    "## Cited evidence",
    ...evidence,
    "",
  ].join("\n")
}

const PLAN_BASENAME = "2026-06-07-001-feat-work-vs-plan-verification-probe-plan"
const RUN_ID = "20260608-143022-a1b2c3d4"
const PLAN_PATH = `docs/plans/${PLAN_BASENAME}.md`
const TODAY = "2026-06-08"

describe("drift-event capture — grouped-list projection on the eval fixture", () => {
  test("the fixture envelope groups to the expected IDs by verdict", () => {
    const { grouped } = envelopeFrom(GROUND_TRUTH, { plan_path: PLAN_PATH, run_id: RUN_ID })
    expect(grouped.drifted).toEqual(["U3"])
    expect(grouped.attempted).toEqual(["U1", "U3", "U5"])
    expect(grouped.remaining).toEqual(["U2"])
    expect(grouped.unverifiable).toEqual(["U4"])
  })
})

describe("drift-event capture — assembled artifact honors the contract", () => {
  const env = envelopeFrom(GROUND_TRUTH, { plan_path: PLAN_PATH, run_id: RUN_ID })
  const artifact = assembleDriftEvent(env, { today: TODAY, planBasename: PLAN_BASENAME })

  test("(a) the data block lists exactly the grouped IDs by verdict", () => {
    expect(artifact).toContain("drifted: [U3]")
    expect(artifact).toContain("attempted: [U1, U3, U5]")
    expect(artifact).toContain("remaining: [U2]")
    expect(artifact).toContain("unverifiable: [U4]")
  })

  test("(b) the artifact contains no drift_rate or any precomputed rate", () => {
    expect(artifact).not.toContain("drift_rate")
    expect(artifact).not.toMatch(/^\s*rate:/m) // no bare rate field
    expect(artifact).not.toContain("0.33") // the derived value never leaks in
  })

  test("(c) the frontmatter passes validate-frontmatter.py (parser-safety, exit 0)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "drift-event-"))
    const file = path.join(dir, `${PLAN_BASENAME}--${RUN_ID}.md`)
    writeFileSync(file, artifact, "utf8")
    const result = spawnSync("python3", [FRONTMATTER_VALIDATOR, file], { encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("OK:")
  })

  test("(d) required drift-event keys are present (validator does not check this)", () => {
    // Frontmatter keys.
    for (const key of ["date:", "plan:", "run_id:", "tags:"]) expect(artifact).toContain(key)
    // Data-block keys (the four lists plus the run flags).
    for (const key of [
      "plan_path:",
      "low_confidence:",
      "degraded:",
      "drifted:",
      "attempted:",
      "remaining:",
      "unverifiable:",
    ]) {
      expect(artifact).toContain(key)
    }
    // Cited evidence is drawn from the attempted units.
    expect(artifact).toContain("## Cited evidence")
    expect(artifact).toContain("- U3 (drifted):")
    expect(artifact).toContain("- U1 (done):")
  })
})

describe("drift-event capture — write gate (skip / degraded / invalid_input)", () => {
  test("an attempted-bearing run is captured", () => {
    const env = envelopeFrom(GROUND_TRUTH, { plan_path: PLAN_PATH, run_id: RUN_ID })
    expect(shouldCapture(env)).toBe(true)
    expect(env.counts.attempted).toBeGreaterThan(0)
  })

  test("an all-remaining run (attempted 0) is skipped — no event assembled", () => {
    const env = envelopeFrom(
      { U1: "remaining", U2: "remaining" },
      { plan_path: PLAN_PATH, run_id: RUN_ID },
    )
    expect(env.counts.attempted).toBe(0)
    expect(env.drift_rate).toBeNull()
    expect(shouldCapture(env)).toBe(false)
  })

  test("an invalid_input envelope is never written", () => {
    const env = envelopeFrom(GROUND_TRUTH, { status: "invalid_input", plan_path: PLAN_PATH, run_id: RUN_ID })
    expect(shouldCapture(env)).toBe(false)
  })

  test("a degraded run is captured with degraded: true in the data block", () => {
    const env = envelopeFrom(GROUND_TRUTH, { status: "degraded", plan_path: PLAN_PATH, run_id: RUN_ID })
    expect(shouldCapture(env)).toBe(true)
    const artifact = assembleDriftEvent(env, { today: TODAY, planBasename: PLAN_BASENAME })
    expect(artifact).toContain("degraded: true")
  })

  test("a complete run records degraded: false", () => {
    const env = envelopeFrom(GROUND_TRUTH, { plan_path: PLAN_PATH, run_id: RUN_ID })
    const artifact = assembleDriftEvent(env, { today: TODAY, planBasename: PLAN_BASENAME })
    expect(artifact).toContain("degraded: false")
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
//
// ---------------------------------------------------------------------------
// DRIFT-EVENT CAPTURE (Phase 4) — live acceptance gate, PENDING.
// ---------------------------------------------------------------------------
// The static assertions above prove the contract is satisfiable from the
// deterministic grouped lists. The remaining gate — that the orchestrator's
// Phase 4 prose actually writes the artifact — cannot run in this session:
// SKILL.md behavior caches at session start (AGENTS.md), so the live capture
// must be exercised in a FRESH session or via the skill-creator eval path.
//
// To run: `/ce-verify-work tests/fixtures/verify-work/sample-plan.md` (Claude
// Code), then confirm:
//   - exactly one file at docs/drift-events/<plan-basename>--<run_id>.md;
//   - its frontmatter passes validate-frontmatter.py (exit 0);
//   - its data block lists drifted: [U3], attempted: [U1, U3, U5],
//     remaining: [U2], unverifiable: [U4] — matching the presented verdict
//     table — with NO drift_rate field anywhere;
//   - an all-remaining plan writes NO event and prints the skip line.
// Record the trial here (mirroring the N=3 block above) once run.
