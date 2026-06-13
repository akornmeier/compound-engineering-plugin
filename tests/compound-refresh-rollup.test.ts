import { describe, expect, test } from "bun:test"
import {
  normalizeVerdict,
  rollupClassifications,
  buildClusters,
  contradictionTermination,
  AMBIGUITY_CONFIDENCE_THRESHOLD,
  CONTRADICTION_K,
  CONTRADICTION_CAP,
} from "../plugins/compound-engineering/skills/ce-compound-refresh/workflows/classify-rollup.js"

// Unit tests for the ce-compound-refresh canonical module — the deterministic,
// safety-critical core of the corpus-audit workflow. The whole conversion's
// safety invariant (mark ambiguous stale, NEVER destructively act on ambiguity)
// lives here, stated once, so the workflow path and the prose fallback cannot
// diverge. These tests ARE that invariant's specification.

const DOC = (over: Record<string, unknown> = {}) => ({
  path: "docs/solutions/skill-design/example.md",
  verdict: "Keep",
  confidence: 100,
  evidence: "still accurate",
  module: "ce-compound-refresh",
  tags: ["skill-design"],
  problem_type: "convention",
  ...over,
})

describe("normalizeVerdict — stale-on-ambiguity coercion (R5)", () => {
  test("an ambiguous (low-confidence) destructive verdict coerces to stale, not the raw value", () => {
    const n = normalizeVerdict(DOC({ verdict: "Delete", confidence: 50 }))
    expect(n.record).toBe("valid")
    expect(n.verdict).toBe("stale")
    expect(n.coerced_from).toBe("Delete")
  })

  test("an explicit Update-vs-Replace ambiguity flag coerces to stale even at full confidence", () => {
    const n = normalizeVerdict(DOC({ verdict: "Replace", confidence: 100, ambiguous: true }))
    expect(n.verdict).toBe("stale")
    expect(n.coerced_from).toBe("Replace")
  })

  test("a Replace with explicit insufficient evidence coerces to stale", () => {
    const n = normalizeVerdict(DOC({ verdict: "Replace", confidence: 100, replace_evidence_sufficient: false }))
    expect(n.verdict).toBe("stale")
    expect(n.coerced_from).toBe("Replace")
  })

  test("a Replace with sufficient evidence at full confidence is preserved", () => {
    const n = normalizeVerdict(DOC({ verdict: "Replace", confidence: 100, replace_evidence_sufficient: true }))
    expect(n.verdict).toBe("Replace")
    expect(n.coerced_from).toBeNull()
  })

  test("a Delete with all three unambiguous auto-delete signals is preserved", () => {
    const n = normalizeVerdict(
      DOC({
        verdict: "Delete",
        confidence: 100,
        implementation_gone: true,
        domain_gone: true,
        inbound_links_clear: true,
      }),
    )
    expect(n.verdict).toBe("Delete")
    expect(n.coerced_from).toBeNull()
  })

  test("a Delete missing any one auto-delete signal coerces to stale", () => {
    const n = normalizeVerdict(
      DOC({
        verdict: "Delete",
        confidence: 100,
        implementation_gone: true,
        domain_gone: true,
        inbound_links_clear: false, // a substantive inbound link remains
      }),
    )
    expect(n.verdict).toBe("stale")
    expect(n.coerced_from).toBe("Delete")
  })

  test("a Consolidate is destructive: it coerces to stale on ambiguity", () => {
    const n = normalizeVerdict(DOC({ verdict: "Consolidate", confidence: 50 }))
    expect(n.verdict).toBe("stale")
    expect(n.coerced_from).toBe("Consolidate")
  })
})

describe("normalizeVerdict — named confidence threshold boundary", () => {
  test("a verdict AT the threshold keeps its class", () => {
    const n = normalizeVerdict(DOC({ verdict: "Update", confidence: AMBIGUITY_CONFIDENCE_THRESHOLD }))
    expect(n.verdict).toBe("Update")
  })

  test("a verdict JUST BELOW the threshold coerces to stale", () => {
    const below = AMBIGUITY_CONFIDENCE_THRESHOLD - 25 // the adjacent lower anchor (75 -> 50)
    const n = normalizeVerdict(DOC({ verdict: "Update", confidence: below }))
    expect(n.verdict).toBe("stale")
    expect(n.coerced_from).toBe("Update")
  })

  test("a confident Keep stays a no-op Keep", () => {
    const n = normalizeVerdict(DOC({ verdict: "Keep", confidence: 100 }))
    expect(n.verdict).toBe("Keep")
    expect(n.coerced_from).toBeNull()
  })

  test("a stale input at low confidence passes through unchanged (not re-coerced)", () => {
    // The `verdict !== "stale"` guard: an already-stale verdict must not accumulate
    // a coerced_from, which would wrongly inflate the coerced count.
    const n = normalizeVerdict(DOC({ verdict: "stale", confidence: 25 }))
    expect(n.verdict).toBe("stale")
    expect(n.coerced_from).toBeNull()
  })
})

describe("normalizeVerdict — failed/malformed classifier entries (R6)", () => {
  test("a null entry is recorded as unverifiable, never Keep", () => {
    const n = normalizeVerdict(null)
    expect(n.record).toBe("failed")
    expect(n.verdict).toBe("unverifiable")
    expect(n.verdict).not.toBe("Keep")
  })

  test("a {path, failed:true} sentinel preserves the path and is unverifiable", () => {
    const n = normalizeVerdict({ path: "docs/solutions/x.md", failed: true })
    expect(n.record).toBe("failed")
    expect(n.path).toBe("docs/solutions/x.md")
    expect(n.verdict).toBe("unverifiable")
  })

  test("a malformed entry (bad verdict enum) is dropped", () => {
    const n = normalizeVerdict(DOC({ verdict: "Frobnicate" }))
    expect(n.record).toBe("dropped")
  })

  test("a malformed entry (no path) is dropped", () => {
    const n = normalizeVerdict(DOC({ path: "" }))
    expect(n.record).toBe("dropped")
  })

  test("a malformed entry (invalid confidence) is dropped", () => {
    const n = normalizeVerdict(DOC({ confidence: 42 }))
    expect(n.record).toBe("dropped")
  })
})

describe("rollupClassifications — fail-closed degraded handling (R6)", () => {
  test("a null/failed classifier yields degraded status and an unverifiable count, never Keep", () => {
    const rolled = rollupClassifications([null, { path: "docs/solutions/y.md", failed: true }], {
      solutionsFileCount: 2,
    })
    expect(rolled.status).toBe("degraded")
    expect(rolled.counts.unverifiable).toBe(2)
    expect(rolled.counts.Keep).toBe(0)
    expect(rolled.grouped.unverifiable).toContain("docs/solutions/y.md")
    expect(rolled.grouped.Keep).toEqual([])
  })

  test("all-valid, all-confident classifications yield complete status", () => {
    const rolled = rollupClassifications(
      [DOC({ path: "docs/solutions/a.md", verdict: "Keep" }), DOC({ path: "docs/solutions/b.md", verdict: "Update" })],
      { solutionsFileCount: 2 },
    )
    expect(rolled.status).toBe("complete")
    expect(rolled.counts.dropped).toBe(0)
  })

  test("a coerced verdict increments the coerced count", () => {
    const rolled = rollupClassifications([DOC({ verdict: "Delete", confidence: 50 })], { solutionsFileCount: 1 })
    expect(rolled.counts.coerced).toBe(1)
    expect(rolled.counts.stale).toBe(1)
    expect(rolled.counts.Delete).toBe(0)
  })

  test("a malformed (dropped) entry forces degraded status, not a silent complete (fail-closed)", () => {
    // A dropped entry is in NO group and has no usable path; if it did not force
    // degraded, the run would read "complete" while a doc went unprocessed.
    const rolled = rollupClassifications(
      [
        DOC({ path: "docs/solutions/a.md", verdict: "Keep" }),
        { path: "docs/solutions/bad.md", verdict: "Frobnicate", confidence: 100 },
      ],
      { solutionsFileCount: 2 },
    )
    expect(rolled.counts.dropped).toBe(1)
    expect(rolled.status).toBe("degraded")
    expect(rolled.grouped.Keep).toEqual(["docs/solutions/a.md"])
  })
})

describe("rollupClassifications — deterministic sort + grouped projection (R7)", () => {
  const scrambled = [
    DOC({ path: "docs/solutions/c.md", verdict: "Update" }),
    DOC({ path: "docs/solutions/a.md", verdict: "Keep" }),
    DOC({ path: "docs/solutions/b.md", verdict: "Update" }),
  ]

  test("verdicts are ordered on the path total key regardless of input order", () => {
    const rolled = rollupClassifications(scrambled, { solutionsFileCount: 3 })
    expect(rolled.verdicts.map((v: { path: string }) => v.path)).toEqual([
      "docs/solutions/a.md",
      "docs/solutions/b.md",
      "docs/solutions/c.md",
    ])
  })

  test("sort output is identical across two different input orders", () => {
    const reversed = [...scrambled].reverse()
    const a = rollupClassifications(scrambled, { solutionsFileCount: 3 })
    const b = rollupClassifications(reversed, { solutionsFileCount: 3 })
    expect(JSON.stringify(a.verdicts)).toBe(JSON.stringify(b.verdicts))
  })

  test("grouped projection membership equals the filter over the sorted flat list", () => {
    const rolled = rollupClassifications(scrambled, { solutionsFileCount: 3 })
    const expectedUpdate = rolled.verdicts
      .filter((v: { verdict: string }) => v.verdict === "Update")
      .map((v: { path: string }) => v.path)
    expect(rolled.grouped.Update).toEqual(expectedUpdate)
    expect(rolled.grouped.Keep).toEqual(["docs/solutions/a.md"])
  })

  test("empty corpus yields a clean empty envelope with status complete", () => {
    const rolled = rollupClassifications([], { solutionsFileCount: 0 })
    expect(rolled.solutions_file_count).toBe(0)
    expect(rolled.verdicts).toEqual([])
    expect(rolled.status).toBe("complete")
    expect(rolled.grouped.Update).toEqual([])
    expect(rolled.grouped.stale).toEqual([])
  })
})

describe("buildClusters — cluster-bounded contradiction grouping (KTD6)", () => {
  const verdicts = [
    { path: "docs/solutions/auth1.md", verdict: "Keep", module: "auth", tags: ["session"], problem_type: "logic_error" },
    { path: "docs/solutions/auth2.md", verdict: "Update", module: "auth", tags: ["token"], problem_type: "logic_error" },
    { path: "docs/solutions/lonely.md", verdict: "Keep", module: "billing", tags: ["invoice"], problem_type: "ui_bug" },
  ]

  test("verdicts sharing a module form one cluster; the unique-key doc is a singleton", () => {
    const { clusters, singletons } = buildClusters(verdicts)
    expect(clusters).toEqual([["docs/solutions/auth1.md", "docs/solutions/auth2.md"]])
    expect(singletons).toEqual(["docs/solutions/lonely.md"])
  })

  test("clustering is deterministic across scrambled input", () => {
    const a = buildClusters(verdicts)
    const b = buildClusters([...verdicts].reverse())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  test("unverifiable (failed-classifier) entries are excluded from contradiction clustering", () => {
    const { clusters, singletons } = buildClusters([
      ...verdicts,
      { path: "docs/solutions/failed.md", verdict: "unverifiable" },
    ])
    expect(clusters.flat()).not.toContain("docs/solutions/failed.md")
    expect(singletons).not.toContain("docs/solutions/failed.md")
  })

  test("with no module, entries cluster by problem_type (key-precedence fallback)", () => {
    const { clusters, singletons } = buildClusters([
      { path: "docs/solutions/p1.md", verdict: "Keep", module: "", tags: [], problem_type: "logic_error" },
      { path: "docs/solutions/p2.md", verdict: "Update", module: "", tags: [], problem_type: "logic_error" },
    ])
    expect(clusters).toEqual([["docs/solutions/p1.md", "docs/solutions/p2.md"]])
    expect(singletons).toEqual([])
  })

  test("with no module or problem_type, entries cluster by their first sorted tag", () => {
    const { clusters } = buildClusters([
      { path: "docs/solutions/t1.md", verdict: "Keep", module: "", tags: ["zebra", "alpha"], problem_type: "" },
      { path: "docs/solutions/t2.md", verdict: "Keep", module: "", tags: ["alpha", "beta"], problem_type: "" },
    ])
    expect(clusters).toEqual([["docs/solutions/t1.md", "docs/solutions/t2.md"]]) // both key on tag "alpha"
  })

  test("entries with no module/problem_type/tags become singletons (null key)", () => {
    const { clusters, singletons } = buildClusters([
      { path: "docs/solutions/lone1.md", verdict: "Keep", module: "", tags: [], problem_type: "" },
      { path: "docs/solutions/lone2.md", verdict: "Keep", module: "", tags: [], problem_type: "" },
    ])
    expect(clusters).toEqual([])
    expect(singletons).toEqual(["docs/solutions/lone1.md", "docs/solutions/lone2.md"])
  })
})

describe("contradictionTermination — loop-until-dry predicate (R3, KTD5)", () => {
  test("continues while consecutive dry rounds are below K", () => {
    const out = contradictionTermination({ rounds: 1, dry_count: 0, found_new: false, round_failed: false })
    expect(out.action).toBe("continue")
    expect(out.dry_count).toBe(1)
  })

  test("is done with complete status at K consecutive dry rounds", () => {
    const out = contradictionTermination({ rounds: CONTRADICTION_K, dry_count: CONTRADICTION_K - 1, found_new: false, round_failed: false })
    expect(out.action).toBe("done")
    expect(out.status).toBe("complete")
    expect(out.dry_count).toBe(CONTRADICTION_K)
  })

  test("is done with degraded status at the hard cap with an unresolved contradiction", () => {
    const out = contradictionTermination({ rounds: CONTRADICTION_CAP, dry_count: 0, found_new: true, round_failed: false })
    expect(out.action).toBe("done")
    expect(out.status).toBe("degraded")
  })

  test("a failed round at the hard cap returns done/degraded with the dry counter reset", () => {
    // Distinct decision-table case from found_new-at-cap: round_failed resets
    // dry_count to 0 first, THEN the rounds >= cap branch fires.
    const out = contradictionTermination({ rounds: CONTRADICTION_CAP, dry_count: 1, found_new: false, round_failed: true })
    expect(out.action).toBe("done")
    expect(out.status).toBe("degraded")
    expect(out.dry_count).toBe(0)
  })

  test("a failed round never increments the dry counter (fail-closed)", () => {
    const out = contradictionTermination({ rounds: 2, dry_count: 1, found_new: false, round_failed: true })
    expect(out.dry_count).toBe(0)
    expect(out.dry_count).not.toBe(2)
  })

  test("a new contradiction resets the dry counter to zero", () => {
    const out = contradictionTermination({ rounds: 3, dry_count: 1, found_new: true, round_failed: false })
    expect(out.dry_count).toBe(0)
    expect(out.action).toBe("continue")
  })
})

describe("exported tuning constants are present for prose-fallback parity", () => {
  test("K, cap, and the confidence threshold are exported numbers", () => {
    expect(typeof CONTRADICTION_K).toBe("number")
    expect(typeof CONTRADICTION_CAP).toBe("number")
    expect(typeof AMBIGUITY_CONFIDENCE_THRESHOLD).toBe("number")
    expect(CONTRADICTION_K).toBe(2)
    expect(CONTRADICTION_CAP).toBe(5)
  })
})
