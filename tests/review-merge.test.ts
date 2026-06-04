import { describe, expect, test } from "bun:test"
// First runtime module shipped inside a skill directory. Imported here directly;
// the dynamic workflow (U2) inlines the same source.
import { mergeFindings, normalize } from "../plugins/compound-engineering/skills/ce-code-review/workflows/merge-findings.js"

// --- factories ---------------------------------------------------------------

type Finding = {
  title: string
  severity: string
  file: string
  line: number
  confidence: number
  autofix_class: string
  owner: string
  requires_verification: boolean
  pre_existing: boolean
  suggested_fix?: string | null
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: "Null deref on empty list",
    severity: "P1",
    file: "src/app.ts",
    line: 10,
    confidence: 75,
    autofix_class: "gated_auto",
    owner: "downstream-resolver",
    requires_verification: false,
    pre_existing: false,
    ...overrides,
  }
}

function ret(reviewer: string, findings: Finding[], extra: { residual_risks?: string[]; testing_gaps?: string[] } = {}) {
  return {
    reviewer,
    findings,
    residual_risks: extra.residual_risks ?? [],
    testing_gaps: extra.testing_gaps ?? [],
  }
}

// --- normalize ---------------------------------------------------------------

describe("normalize", () => {
  test("lowercases, trims, collapses whitespace", () => {
    expect(normalize("  Src/App.TS  ")).toBe("src/app.ts")
    expect(normalize("Null   deref\ton  empty")).toBe("null deref on empty")
  })
})

// --- dedup / merge -----------------------------------------------------------

describe("dedup and merge", () => {
  test("merges same-loc findings: keeps highest severity and highest anchor", () => {
    // Same reviewer twice so no cross-reviewer promotion clouds the assertion.
    const out = mergeFindings([
      ret("correctness", [
        finding({ severity: "P2", confidence: 50, line: 10 }),
        finding({ severity: "P1", confidence: 75, line: 12 }), // within +/-3
      ]),
    ])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0].severity).toBe("P1")
    expect(out.findings[0].confidence).toBe(75)
    expect(out.findings[0].reviewers).toEqual(["correctness"])
  })

  test("records every contributing reviewer", () => {
    const out = mergeFindings([
      ret("security", [finding({ line: 10 })]),
      ret("correctness", [finding({ line: 11 })]),
    ])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0].reviewers).toEqual(["correctness", "security"])
  })

  test("findings more than 3 lines apart do not merge", () => {
    const out = mergeFindings([
      ret("correctness", [finding({ line: 10 }), finding({ line: 14 })]),
    ])
    expect(out.findings).toHaveLength(2)
  })

  test("different titles at same line do not merge", () => {
    const out = mergeFindings([
      ret("correctness", [
        finding({ title: "Off by one", line: 10 }),
        finding({ title: "Unchecked nil", line: 10 }),
      ]),
    ])
    expect(out.findings).toHaveLength(2)
  })
})

// --- cross-reviewer promotion ------------------------------------------------

describe("cross-reviewer agreement promotion", () => {
  test("2+ reviewers promote one anchor step: 50 -> 75", () => {
    const out = mergeFindings([
      ret("security", [finding({ confidence: 50, line: 10 })]),
      ret("correctness", [finding({ confidence: 50, line: 10 })]),
    ])
    expect(out.findings[0].confidence).toBe(75)
  })

  test("75 -> 100 and 100 -> 100", () => {
    const at75 = mergeFindings([
      ret("a", [finding({ confidence: 75, line: 10 })]),
      ret("b", [finding({ confidence: 75, line: 10 })]),
    ])
    expect(at75.findings[0].confidence).toBe(100)

    const at100 = mergeFindings([
      ret("a", [finding({ confidence: 100, line: 10 })]),
      ret("b", [finding({ confidence: 100, line: 10 })]),
    ])
    expect(at100.findings[0].confidence).toBe(100)
  })

  test("single reviewer does not promote", () => {
    const out = mergeFindings([ret("a", [finding({ severity: "P0", confidence: 50, line: 10 })])])
    expect(out.findings[0].confidence).toBe(50)
  })
})

// --- pre-existing ------------------------------------------------------------

describe("pre-existing separation", () => {
  test("pre_existing findings move to a separate list", () => {
    const out = mergeFindings([
      ret("a", [finding({ pre_existing: true, title: "old bug" })]),
      ret("b", [finding({ pre_existing: false, title: "new bug" })]),
    ])
    expect(out.pre_existing_findings).toHaveLength(1)
    expect(out.pre_existing_findings[0].title).toBe("old bug")
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0].title).toBe("new bug")
  })

  test("a finding only counts as pre-existing when all contributors agree", () => {
    const out = mergeFindings([
      ret("a", [finding({ pre_existing: true, line: 10 })]),
      ret("b", [finding({ pre_existing: false, line: 10 })]),
    ])
    expect(out.pre_existing_findings).toHaveLength(0)
    expect(out.findings).toHaveLength(1)
  })
})

// --- mode-aware demotion -----------------------------------------------------

describe("mode-aware demotion", () => {
  test("P3 advisory from testing only -> testing_gaps", () => {
    const out = mergeFindings([
      ret("testing", [finding({ severity: "P3", autofix_class: "advisory", confidence: 100, title: "weak coverage", line: 5 })]),
    ])
    expect(out.findings).toHaveLength(0)
    expect(out.testing_gaps).toContain("src/app.ts:5 -- weak coverage")
    expect(out.coverage.demoted).toBe(1)
  })

  test("P2 advisory from maintainability only -> residual_risks", () => {
    const out = mergeFindings([
      ret("maintainability", [finding({ severity: "P2", autofix_class: "advisory", confidence: 100, title: "naming nit", line: 7 })]),
    ])
    expect(out.findings).toHaveLength(0)
    expect(out.residual_risks).toContain("src/app.ts:7 -- naming nit")
  })

  test("corroboration by another persona keeps it in primary", () => {
    const out = mergeFindings([
      ret("testing", [finding({ severity: "P2", autofix_class: "advisory", confidence: 75, line: 10 })]),
      ret("security", [finding({ severity: "P2", autofix_class: "advisory", confidence: 75, line: 10 })]),
    ])
    expect(out.findings).toHaveLength(1)
    expect(out.coverage.demoted).toBe(0)
  })

  test("P1 from testing is never demoted (only P2/P3 qualify)", () => {
    const out = mergeFindings([
      ret("testing", [finding({ severity: "P1", autofix_class: "advisory", confidence: 75, line: 10 })]),
    ])
    expect(out.findings).toHaveLength(1)
  })
})

// --- confidence gate ---------------------------------------------------------

describe("confidence gate", () => {
  test("suppresses below anchor 75 and records counts by anchor", () => {
    const out = mergeFindings([
      ret("a", [
        finding({ severity: "P1", confidence: 50, line: 10, title: "a" }),
        finding({ severity: "P2", confidence: 25, line: 50, title: "b" }),
      ]),
    ])
    expect(out.findings).toHaveLength(0)
    expect(out.coverage.suppressed_by_anchor).toEqual({ "50": 1, "25": 1 })
  })

  test("P0 at anchor 50 survives the gate (escape hatch)", () => {
    const out = mergeFindings([
      ret("a", [finding({ severity: "P0", confidence: 50, line: 10 })]),
    ])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0].severity).toBe("P0")
  })

  test("anchor 75 and 100 always survive", () => {
    const out = mergeFindings([
      ret("a", [
        finding({ confidence: 75, line: 10, title: "a" }),
        finding({ confidence: 100, line: 50, title: "b" }),
      ]),
    ])
    expect(out.findings).toHaveLength(2)
  })
})

// --- sort and number ---------------------------------------------------------

describe("sort and number", () => {
  test("orders by severity -> anchor desc -> file -> line with monotonic numbering", () => {
    const out = mergeFindings([
      ret("a", [
        finding({ severity: "P2", confidence: 75, file: "z.ts", line: 1, title: "p2" }),
        finding({ severity: "P0", confidence: 75, file: "b.ts", line: 9, title: "p0-lo" }),
        finding({ severity: "P0", confidence: 100, file: "a.ts", line: 5, title: "p0-hi" }),
        finding({ severity: "P1", confidence: 100, file: "m.ts", line: 2, title: "p1" }),
      ]),
    ])
    expect(out.findings.map((f) => f.title)).toEqual(["p0-hi", "p0-lo", "p1", "p2"])
    expect(out.findings.map((f) => f.number)).toEqual([1, 2, 3, 4])
  })
})

// --- partition ---------------------------------------------------------------

describe("partition", () => {
  test("actionable queue is gated_auto/manual owned by downstream-resolver, reusing the stable number", () => {
    const out = mergeFindings([
      ret("a", [
        finding({ autofix_class: "gated_auto", owner: "downstream-resolver", confidence: 100, line: 10, title: "act" }),
        finding({ autofix_class: "advisory", owner: "release", confidence: 100, line: 50, title: "report" }),
      ]),
    ])
    expect(out.actionable_findings.map((f) => f.title)).toEqual(["act"])
    const act = out.findings.find((f) => f.title === "act")
    expect(out.actionable_findings[0].number).toBe(act?.number)
  })
})

// --- validation --------------------------------------------------------------

describe("validation", () => {
  test("drops a finding with a float confidence and counts it", () => {
    const out = mergeFindings([
      ret("a", [
        finding({ confidence: 100, line: 10, title: "ok" }),
        { ...finding({ line: 50 }), confidence: 0.73 } as unknown as Finding,
      ]),
    ])
    expect(out.findings.map((f) => f.title)).toEqual(["ok"])
    expect(out.coverage.dropped_findings).toBe(1)
  })

  test("drops a whole return missing a required top-level array", () => {
    const out = mergeFindings([
      { reviewer: "a", findings: [finding()], residual_risks: [] } as never, // no testing_gaps
      ret("b", [finding({ title: "kept", confidence: 100 })]),
    ])
    expect(out.coverage.dropped_returns).toBe(1)
    expect(out.findings).toHaveLength(1)
  })

  test("drops findings with invalid enum values", () => {
    const out = mergeFindings([
      ret("a", [
        finding({ severity: "P9" as unknown as string, line: 10 }),
        finding({ autofix_class: "bogus", line: 50 }),
        finding({ title: "kept", confidence: 100, line: 90 }),
      ]),
    ])
    expect(out.findings.map((f) => f.title)).toEqual(["kept"])
    expect(out.coverage.dropped_findings).toBe(2)
  })

  test("remaps legacy route vocabulary instead of dropping", () => {
    const out = mergeFindings([
      ret("a", [finding({ autofix_class: "safe_auto", owner: "review-fixer", confidence: 100, line: 10 })]),
    ])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0].autofix_class).toBe("gated_auto")
    expect(out.findings[0].owner).toBe("downstream-resolver")
  })
})

// --- conservative routing ----------------------------------------------------

describe("conservative routing on disagreement", () => {
  test("keeps the more conservative autofix_class and owner across contributors", () => {
    const out = mergeFindings([
      ret("a", [finding({ autofix_class: "gated_auto", owner: "downstream-resolver", line: 10 })]),
      ret("b", [finding({ autofix_class: "manual", owner: "human", line: 10 })]),
    ])
    expect(out.findings[0].autofix_class).toBe("manual")
    expect(out.findings[0].owner).toBe("human")
  })

  test("requires_verification is OR-ed across contributors", () => {
    const out = mergeFindings([
      ret("a", [finding({ requires_verification: false, line: 10 })]),
      ret("b", [finding({ requires_verification: true, line: 10 })]),
    ])
    expect(out.findings[0].requires_verification).toBe(true)
  })
})

// --- determinism -------------------------------------------------------------

describe("determinism", () => {
  test("identical input yields byte-identical output across runs", () => {
    const input = [
      ret("security", [finding({ severity: "P0", confidence: 50, line: 10 })]),
      ret("correctness", [finding({ severity: "P2", confidence: 75, line: 40, title: "other" })]),
    ]
    const a = JSON.stringify(mergeFindings(input))
    const b = JSON.stringify(mergeFindings(input))
    expect(a).toBe(b)
  })
})
