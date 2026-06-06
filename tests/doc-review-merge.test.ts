import { describe, expect, test } from "bun:test"
// Pure mechanical brackets of the ce-doc-review synthesis pipeline. Imported
// directly here; the dynamic workflow (U2) inlines the same source.
import {
  mergeFront,
  mergeBack,
  normalize,
} from "../plugins/compound-engineering/skills/ce-doc-review/workflows/merge-doc-findings.js"

// --- factories ---------------------------------------------------------------

type Finding = {
  title: string
  severity: string
  section: string
  why_it_matters: string
  finding_type: string
  autofix_class: string
  confidence: number
  evidence: string[]
  suggested_fix?: string | null
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: "Deploy ordering unspecified",
    severity: "P1",
    section: "Unit 4",
    why_it_matters: "Implementers have no safe deploy recipe.",
    finding_type: "omission",
    autofix_class: "gated_auto",
    confidence: 75,
    evidence: ["If the migration runs before Units 1-3 land, the code reads stale data."],
    suggested_fix: "Require Units 1-4 to land in a single atomic PR.",
    ...overrides,
  }
}

function ret(
  reviewer: string,
  findings: Finding[],
  extra: { residual_risks?: string[]; deferred_questions?: string[] } = {},
) {
  return {
    reviewer,
    findings,
    residual_risks: extra.residual_risks ?? [],
    deferred_questions: extra.deferred_questions ?? [],
  }
}

// An annotated finding as the synthesis agent would return it to mergeBack.
function annotated(overrides: Record<string, unknown> = {}) {
  return {
    id: "unit 4|deploy ordering unspecified",
    section: "Unit 4",
    title: "Deploy ordering unspecified",
    severity: "P1",
    finding_type: "omission",
    why_it_matters: "Implementers have no safe deploy recipe.",
    evidence: ["..."],
    reviewers: ["feasibility"],
    confidence: 75,
    autofix_class: "gated_auto",
    recommended_action: "Apply",
    suggested_fix: "Require Units 1-4 to land in a single atomic PR.",
    depends_on: null,
    dependents: [],
    variant_count: 0,
    _order: 0,
    ...overrides,
  }
}

// --- normalize ---------------------------------------------------------------

describe("normalize", () => {
  test("lowercases, trims, collapses whitespace", () => {
    expect(normalize("  Unit 4  ")).toBe("unit 4")
    expect(normalize("Deploy   ordering\tunspecified")).toBe("deploy ordering unspecified")
  })
})

// --- 3.1 Validate ------------------------------------------------------------

describe("mergeFront 3.1 validate", () => {
  test("drops a finding with a float confidence, keeps the rest, records the persona", () => {
    const out = mergeFront([
      ret("coherence", [
        finding({ confidence: 100, title: "ok" }),
        { ...finding({ title: "bad", section: "Summary" }), confidence: 72 } as unknown as Finding,
      ]),
    ])
    expect(out.findings.map((f) => f.title)).toEqual(["ok"])
    expect(out.coverage.dropped_findings).toBe(1)
    expect(out.coverage.malformed_agents).toContain("coherence")
  })

  test("drops a finding with an invalid severity enum", () => {
    const out = mergeFront([
      ret("feasibility", [
        finding({ severity: "high" as unknown as string, title: "bad" }),
        finding({ title: "kept", confidence: 100, section: "Summary" }),
      ]),
    ])
    expect(out.findings.map((f) => f.title)).toEqual(["kept"])
    expect(out.coverage.dropped_findings).toBe(1)
  })

  test("drops legacy pre-rename autofix_class values (auto/present treated as malformed)", () => {
    const out = mergeFront([
      ret("a", [
        finding({ autofix_class: "auto" as unknown as string, title: "legacy", confidence: 100 }),
        finding({ title: "kept", confidence: 100, section: "Summary" }),
      ]),
    ])
    expect(out.findings.map((f) => f.title)).toEqual(["kept"])
    expect(out.coverage.dropped_findings).toBe(1)
  })

  test("drops a finding with single-string evidence (must be an array)", () => {
    const out = mergeFront([
      ret("a", [
        { ...finding({ title: "bad" }), evidence: "a single quote" } as unknown as Finding,
        finding({ title: "kept", section: "Summary", confidence: 100 }),
      ]),
    ])
    expect(out.findings.map((f) => f.title)).toEqual(["kept"])
    expect(out.coverage.dropped_findings).toBe(1)
  })

  test("drops a whole return missing a required top-level array", () => {
    const out = mergeFront([
      { reviewer: "a", findings: [finding()], residual_risks: [] } as never, // no deferred_questions
      ret("b", [finding({ title: "kept", confidence: 100, section: "Summary" })]),
    ])
    expect(out.coverage.dropped_returns).toBe(1)
    expect(out.findings.map((f) => f.title)).toEqual(["kept"])
  })
})

// --- 3.2 Confidence Gate -----------------------------------------------------

describe("mergeFront 3.2 anchor gate", () => {
  test("drops anchors 0 and 25 silently with a drop count", () => {
    const out = mergeFront([
      ret("a", [
        finding({ confidence: 0, title: "z", section: "S0" }),
        finding({ confidence: 25, title: "y", section: "S1" }),
        finding({ confidence: 75, title: "keep", section: "S2" }),
      ]),
    ])
    expect(out.findings.map((f) => f.title)).toEqual(["keep"])
    expect(out.coverage.dropped).toBe(2)
  })

  test("anchor 50 survives the front (routed to FYI later by mergeBack)", () => {
    const out = mergeFront([ret("a", [finding({ confidence: 50, title: "fyi", section: "S" })])])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0].confidence).toBe(50)
  })

  test("a P0 at anchor 25 is still dropped (anchor gates the surface, severity does not rescue it)", () => {
    const out = mergeFront([ret("a", [finding({ severity: "P0", confidence: 25, title: "p0low" })])])
    expect(out.findings).toHaveLength(0)
    expect(out.coverage.dropped).toBe(1)
  })
})

// --- 3.3 Deduplicate ---------------------------------------------------------

describe("mergeFront 3.3 cross-persona dedup", () => {
  test("two personas, same section+normalized title -> merged once, highest severity+anchor, both recorded", () => {
    const out = mergeFront([
      ret("coherence", [finding({ severity: "P2", confidence: 75, section: "Unit 4", title: "Deploy ordering" })]),
      ret("feasibility", [finding({ severity: "P1", confidence: 100, section: "Unit 4", title: "Deploy ordering" })]),
    ])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0].severity).toBe("P1")
    expect(out.findings[0].confidence).toBe(100) // highest anchor; no cross-persona promotion in the front (that is 3.4, agent-side)
    expect(out.findings[0].reviewers).toEqual(["coherence", "feasibility"])
  })

  test("unions evidence across merged personas", () => {
    const out = mergeFront([
      ret("a", [finding({ section: "S", title: "T", evidence: ["e1"] })]),
      ret("b", [finding({ section: "S", title: "T", evidence: ["e2"] })]),
    ])
    expect(out.findings[0].evidence.sort()).toEqual(["e1", "e2"])
  })

  test("decrements the losing persona's coverage count so totals stay exact", () => {
    const out = mergeFront([
      ret("a", [finding({ section: "S", title: "T", confidence: 100 })]),
      ret("b", [finding({ section: "S", title: "T", confidence: 75 })]),
    ])
    // one merged finding attributed to the higher-anchor persona (a)
    expect(out.findings).toHaveLength(1)
    expect(out.coverage.dedup_merged).toBe(1)
  })

  test("different sections with the same title do not merge", () => {
    const out = mergeFront([
      ret("a", [finding({ section: "Unit 4", title: "Scope", confidence: 100 })]),
      ret("b", [finding({ section: "Unit 5", title: "Scope", confidence: 100 })]),
    ])
    expect(out.findings).toHaveLength(2)
  })

  test("assigns a stable id of normalize(section)|normalize(title)", () => {
    const out = mergeFront([ret("a", [finding({ section: "Unit 4", title: "Deploy Ordering" })])])
    expect(out.findings[0].id).toBe("unit 4|deploy ordering")
  })
})

// --- mergeFront determinism --------------------------------------------------

describe("mergeFront determinism", () => {
  test("identical input yields byte-identical output across runs", () => {
    const input = [
      ret("coherence", [finding({ severity: "P0", confidence: 50, section: "Summary", title: "a" })]),
      ret("feasibility", [finding({ severity: "P2", confidence: 75, section: "Unit 2", title: "b" })]),
    ]
    expect(JSON.stringify(mergeFront(input))).toBe(JSON.stringify(mergeFront(input)))
  })
})

// --- 3.7 Route ---------------------------------------------------------------

describe("mergeBack 3.7 route by anchor x autofix_class", () => {
  test("100 + safe_auto with a fix -> applied bucket", () => {
    const out = mergeBack(
      [annotated({ confidence: 100, autofix_class: "safe_auto", suggested_fix: "fix it" })],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.applied).toHaveLength(1)
    expect(out.proposed_fixes).toHaveLength(0)
  })

  test("100 + safe_auto missing a fix -> demoted to gated_auto (proposed_fixes)", () => {
    const out = mergeBack(
      [annotated({ confidence: 100, autofix_class: "safe_auto", suggested_fix: null })],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.applied).toHaveLength(0)
    expect(out.proposed_fixes).toHaveLength(1)
  })

  test("75 + safe_auto -> demoted to gated_auto, never silent-applied", () => {
    const out = mergeBack(
      [annotated({ confidence: 75, autofix_class: "safe_auto", suggested_fix: "fix it" })],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.applied).toHaveLength(0)
    expect(out.proposed_fixes).toHaveLength(1)
  })

  test("75 + gated_auto missing a fix -> demoted to manual (decisions)", () => {
    const out = mergeBack(
      [annotated({ confidence: 75, autofix_class: "gated_auto", suggested_fix: null })],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.proposed_fixes).toHaveLength(0)
    expect(out.decisions).toHaveLength(1)
  })

  test("manual with no suggested_fix -> decisions, no demotion", () => {
    const out = mergeBack(
      [annotated({ confidence: 100, autofix_class: "manual", suggested_fix: null })],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.decisions).toHaveLength(1)
  })

  test("anchor 50 + any class -> FYI, never actionable", () => {
    const out = mergeBack(
      [
        annotated({ id: "a", confidence: 50, autofix_class: "safe_auto", suggested_fix: "x" }),
        annotated({ id: "b", confidence: 50, autofix_class: "manual" }),
      ],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.fyi).toHaveLength(2)
    expect(out.applied).toHaveLength(0)
    expect(out.decisions).toHaveLength(0)
  })
})

// --- 3.8 Sort ----------------------------------------------------------------

describe("mergeBack 3.8 sort", () => {
  test("P0 errors before P0 omissions before P1, anchor desc within type, document order final", () => {
    const out = mergeBack(
      [
        annotated({ id: "p1", severity: "P1", finding_type: "error", confidence: 100, autofix_class: "manual", _order: 0 }),
        annotated({ id: "p0-om", severity: "P0", finding_type: "omission", confidence: 100, autofix_class: "manual", _order: 1 }),
        annotated({ id: "p0-err-lo", severity: "P0", finding_type: "error", confidence: 75, autofix_class: "manual", _order: 2 }),
        annotated({ id: "p0-err-hi", severity: "P0", finding_type: "error", confidence: 100, autofix_class: "manual", _order: 3 }),
      ],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.decisions.map((f) => f.id)).toEqual(["p0-err-hi", "p0-err-lo", "p0-om", "p1"])
  })
})

// --- 3.9 Suppress restatements ----------------------------------------------

describe("mergeBack 3.9 suppress restatements", () => {
  test("a deferred question that restates an actionable finding's concern is dropped and counted", () => {
    const out = mergeBack(
      [
        annotated({
          id: "motivation|cites no incident",
          section: "Motivation",
          title: "Motivation cites no real incident",
          why_it_matters: "Motivation has no concrete triggering event to justify the work.",
          confidence: 75,
          autofix_class: "manual",
        }),
      ],
      {
        residual_risks: [],
        deferred_questions: ["Is there a concrete triggering incident behind the Motivation section?"],
      },
    )
    expect(out.deferred_questions).toHaveLength(0)
    expect(out.coverage.restated).toBe(1)
  })

  test("a genuinely new residual concern is kept", () => {
    const out = mergeBack(
      [annotated({ section: "Unit 4", title: "Deploy ordering", why_it_matters: "deploy recipe missing" })],
      {
        residual_risks: ["Rollout cadence across regions is unspecified and may stagger badly."],
        deferred_questions: [],
      },
    )
    expect(out.residual_risks).toHaveLength(1)
    expect(out.coverage.restated).toBe(0)
  })
})

// --- Protected artifacts -----------------------------------------------------

describe("mergeBack protected-artifact drop", () => {
  test("a finding whose suggested_fix recommends deleting a docs/plans/ file is discarded", () => {
    const out = mergeBack(
      [
        annotated({
          id: "drop-me",
          confidence: 100,
          autofix_class: "gated_auto",
          suggested_fix: "Delete docs/plans/2026-01-01-old-plan.md since it is superseded.",
        }),
        annotated({ id: "keep-me", confidence: 100, autofix_class: "manual" }),
      ],
      { residual_risks: [], deferred_questions: [] },
    )
    const ids = [...out.applied, ...out.proposed_fixes, ...out.decisions, ...out.fyi].map((f) => f.id)
    expect(ids).toContain("keep-me")
    expect(ids).not.toContain("drop-me")
  })

  test("a finding that merely mentions a docs/plans/ path without proposing deletion is kept", () => {
    const out = mergeBack(
      [
        annotated({
          id: "keep",
          confidence: 100,
          autofix_class: "gated_auto",
          suggested_fix: "Cross-reference docs/plans/2026-01-01-plan.md in the Summary section.",
        }),
      ],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.proposed_fixes.map((f) => f.id)).toContain("keep")
  })
})

// --- Chains coverage ---------------------------------------------------------

describe("mergeBack chains coverage", () => {
  test("counts roots and dependents from depends_on/dependents annotations", () => {
    const out = mergeBack(
      [
        annotated({ id: "root", severity: "P0", autofix_class: "manual", confidence: 100, dependents: ["d1", "d2"] }),
        annotated({ id: "d1", severity: "P2", autofix_class: "manual", confidence: 75, depends_on: "root" }),
        annotated({ id: "d2", severity: "P2", autofix_class: "manual", confidence: 75, depends_on: "root" }),
      ],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.coverage.chains).toEqual({ roots: 1, dependents: 2 })
  })

  test("omits chains when there are none (roots 0, dependents 0)", () => {
    const out = mergeBack([annotated({ autofix_class: "manual" })], {
      residual_risks: [],
      deferred_questions: [],
    })
    expect(out.coverage.chains).toEqual({ roots: 0, dependents: 0 })
  })
})

// --- mergeBack determinism ---------------------------------------------------

describe("mergeBack determinism", () => {
  test("identical input yields byte-identical output across runs", () => {
    const input = [
      annotated({ id: "a", severity: "P0", autofix_class: "manual", confidence: 100, _order: 0 }),
      annotated({ id: "b", severity: "P1", autofix_class: "gated_auto", confidence: 75, _order: 1 }),
    ]
    const soft = { residual_risks: ["r"], deferred_questions: ["q"] }
    expect(JSON.stringify(mergeBack(input, soft))).toBe(JSON.stringify(mergeBack(input, soft)))
  })
})
