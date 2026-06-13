import path from "node:path"
import { existsSync } from "node:fs"
import { describe, expect, test } from "bun:test"
// @ts-ignore — pure JS module, no type declarations
import {
  normalizeVerdict,
  rollupClassifications,
  buildClusters,
} from "../plugins/compound-engineering/skills/ce-compound-refresh/workflows/classify-rollup.js"

// U6 — eval for the ce-compound-refresh corpus-audit pipeline.
//
// TWO LAYERS, split by determinism:
//   1. The deterministic classify roll-up + clustering is exact-assertable here
//      (variance = 0): given a fixed ground-truth verdict set for the fixture
//      docs, the stale-on-ambiguity coercion, the grouped projection, and the
//      contradiction clustering are byte-stable.
//   2. The model-mediated classification (does the live workflow actually
//      dispatch one classifier per doc, reach the right verdicts, and surface
//      the planted contradiction?) is NOT assertable in `bun test`. It is
//      validated by the MANUAL LIVE SMOKE RUN — a required acceptance gate whose
//      recorded results are documented at the bottom of this file (per
//      dynamic-workflow-conversion-live-boundary.md).

const FIXTURE_DIR = "tests/fixtures/compound-refresh"
const P = {
  keep: `${FIXTURE_DIR}/clear-keep.md`,
  ambiguous: `${FIXTURE_DIR}/planted-ambiguous.md`,
  contradictionA: `${FIXTURE_DIR}/contradiction-a.md`,
  contradictionB: `${FIXTURE_DIR}/contradiction-b.md`,
}

// Ground truth the live classifier should reach for each fixture (the verdict +
// the frontmatter the doc carries). planted-ambiguous is returned as an ambiguous
// Update — exactly the case the module MUST coerce to `stale` (R5).
const GROUND_TRUTH = [
  { path: P.keep, verdict: "Keep", confidence: 100, module: "fixture-logging", tags: ["logging", "conventions"], problem_type: "convention", evidence: "timeless convention, no version-specific refs" },
  { path: P.ambiguous, verdict: "Update", confidence: 50, ambiguous: true, module: "fixture-auth", tags: ["auth", "session"], problem_type: "architecture_pattern", evidence: "partially refactored; Update-vs-Replace unclear from a file scan" },
  { path: P.contradictionA, verdict: "Keep", confidence: 100, module: "fixture-cache", tags: ["cache", "invalidation"], problem_type: "best_practice", evidence: "recommends synchronous invalidation" },
  { path: P.contradictionB, verdict: "Keep", confidence: 100, module: "fixture-cache", tags: ["cache", "invalidation"], problem_type: "best_practice", evidence: "recommends asynchronous invalidation" },
]

describe("fixtures exist on disk for the live run", () => {
  test("all four planted fixture docs are present", () => {
    for (const rel of Object.values(P)) {
      expect(existsSync(path.join(process.cwd(), rel))).toBe(true)
    }
  })
})

describe("deterministic roll-up — exact on the fixtures' ground truth", () => {
  const rolled = rollupClassifications(GROUND_TRUTH, { solutionsFileCount: 4 })

  test("the planted-ambiguous doc is coerced to stale, never a destructive verdict (R5)", () => {
    expect(rolled.grouped.stale).toEqual([P.ambiguous])
    // The safety property, stated as a hard assertion: it is in NO destructive group.
    expect(rolled.grouped.Delete).not.toContain(P.ambiguous)
    expect(rolled.grouped.Replace).not.toContain(P.ambiguous)
    expect(rolled.grouped.Consolidate).not.toContain(P.ambiguous)
  })

  test("the three confident, unambiguous docs are Keep", () => {
    expect(rolled.grouped.Keep).toEqual([P.keep, P.contradictionA, P.contradictionB])
  })

  test("counts reflect 3 Keep + 1 coerced stale, status complete", () => {
    expect(rolled.counts).toMatchObject({ Keep: 3, stale: 1, coerced: 1, unverifiable: 0, dropped: 0 })
    expect(rolled.status).toBe("complete")
    expect(rolled.solutions_file_count).toBe(4)
  })

  test("the grouped projection equals the filter over the sorted flat list", () => {
    for (const g of ["Keep", "stale"]) {
      const expected = rolled.verdicts.filter((v: { verdict: string }) => v.verdict === g).map((v: { path: string }) => v.path)
      expect(rolled.grouped[g]).toEqual(expected)
    }
  })

  test("byte-identical across repeated runs (variance = 0)", () => {
    const a = rollupClassifications(GROUND_TRUTH, { solutionsFileCount: 4 })
    const b = rollupClassifications([...GROUND_TRUTH].reverse(), { solutionsFileCount: 4 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe("contradiction clustering — the planted pair clusters, others isolate", () => {
  const rolled = rollupClassifications(GROUND_TRUTH, { solutionsFileCount: 4 })
  const { clusters, singletons } = buildClusters(rolled.verdicts)

  test("the two fixture-cache docs form exactly one contradiction cluster", () => {
    expect(clusters).toEqual([[P.contradictionA, P.contradictionB]])
  })

  test("the unique-module docs are singletons (no contradiction partner)", () => {
    expect(singletons).toEqual([P.keep, P.ambiguous])
  })
})

describe("safety-coercion control — the module never lets a destructive verdict through on ambiguity", () => {
  test("an ambiguous Delete on a fixture doc coerces to stale", () => {
    const n = normalizeVerdict({ path: P.ambiguous, verdict: "Delete", confidence: 50, module: "fixture-auth" })
    expect(n.verdict).toBe("stale")
    expect(n.coerced_from).toBe("Delete")
  })

  test("a confident Delete WITHOUT all three auto-delete signals still coerces to stale", () => {
    const n = normalizeVerdict({ path: P.ambiguous, verdict: "Delete", confidence: 100, implementation_gone: true, domain_gone: true, inbound_links_clear: false })
    expect(n.verdict).toBe("stale")
  })
})

// ===========================================================================
// LIVE SMOKE RUN — required acceptance gate (results recorded after dispatch)
// ===========================================================================
//
// `bun test` cannot dispatch the Workflow tool, so the live run is performed by
// invoking the real Workflow against the four fixtures above with the committed
// corpus-audit-fanout.generated.js, N>=3 trials. Rerun by passing
//   { paths: [<the four fixture paths>], solutions_file_count: 4,
//     run_id: "corpus-audit-smoke", today: "<YYYY-MM-DD>" }
// as `args` to the Workflow tool with `script` = the generated file's contents.
//
// Asserted at the live boundary (not here):
//   - Envelope `status: complete`, non-zero subagent_tokens, verdicts populated
//     (4 of 4 classified) — not an empty silent run.
//   - planted-ambiguous.md returns `stale`, NEVER a destructive verdict (R5).
//   - the contradiction-a/contradiction-b pair surfaces a contradiction and the
//     loop terminates within CONTRADICTION_CAP rounds (R3).
//   - solutions_file_count == 4 (R4).
//   - across the N trials, the unambiguous docs (clear-keep, the two cache docs)
//     hold stable verdict classes.
//
// RECORDED — PENDING. The static layer above is green; the live dispatch is the
// remaining mandatory acceptance step (billable multi-agent run, requires the
// Workflow tool). Results to be appended here in the form of the N>=3 trial
// table once the live run is performed (mirroring tests/work-vs-plan-workflow-eval.ts).
