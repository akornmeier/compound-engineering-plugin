import { readFile } from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { assembleDocReviewWorkflow, GENERATED_PATH } from "../scripts/build-doc-review-workflow"
import {
  mergeFront,
  mergeBack,
  normalize,
} from "../plugins/compound-engineering/skills/ce-doc-review/workflows/merge-doc-findings.js"

// U5 — build/assembly invariants + identity-level parity of the deterministic
// brackets. The synthesis agent and the persona fan-out are model-mediated;
// BOTH the workflow path AND the prose baseline are non-deterministic, so
// full-pipeline parity and synthesis correctness are NOT assertable in
// `bun test` — they are validated by the LIVE SMOKE RUN (a required acceptance
// gate, documented at the bottom of this file). What is assertable here:
//   1. the build contract (freshness, meta-first, syntax, inlined fns, the
//      three live-boundary runtime contracts pinned at source level);
//   2. the deterministic brackets' exact behavior (variance = 0);
//   3. mergeBack faithfully PRESERVES the synthesis agent's identity
//      annotations (root id, exact depends_on set, surviving-representative id) —
//      so a correct synthesis result is rendered correctly.

const WF_DIR = "plugins/compound-engineering/skills/ce-doc-review/workflows"

async function read(rel: string): Promise<string> {
  return readFile(path.join(process.cwd(), rel), "utf8")
}

// ---------------------------------------------------------------------------
// 1. Build / assembly invariants — the same battery review-workflow-parity runs,
//    plus the doc-review-specific synthesis-agent + full-findings contracts.
// ---------------------------------------------------------------------------

describe("ce-doc-review workflow assembly", () => {
  test("the merge-module marker appears exactly once (no ambiguous match)", async () => {
    const fanout = await read(`${WF_DIR}/doc-review-fanout.js`)
    expect((fanout.match(/\/\* __MERGE_MODULE__ \*\//g) || []).length).toBe(1)
  })

  test("merge module exposes mergeFront + mergeBack via a strippable trailing export", async () => {
    const merge = await read(`${WF_DIR}/merge-doc-findings.js`)
    const stripped = merge.replace(/\nexport\s*\{[^}]*\};\s*$/, "\n")
    expect(stripped).not.toBe(merge) // the export line matched and was removed
    expect(stripped).not.toContain("export {")
    expect(stripped).toContain("function mergeFront")
    expect(stripped).toContain("function mergeBack")
  })

  test("committed generated workflow is up to date with its sources", async () => {
    const committed = await read(GENERATED_PATH)
    const fresh = await assembleDocReviewWorkflow()
    // If this fails, run: bun run scripts/build-doc-review-workflow.ts
    expect(committed).toBe(fresh)
  })

  test("generated workflow keeps `export const meta` as the first statement", async () => {
    const generated = await read(GENERATED_PATH)
    const codeOnly = generated
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
    expect(codeOnly[0].startsWith("export const meta")).toBe(true)
  })

  test("generated workflow is syntactically valid JavaScript", async () => {
    const generated = await read(GENERATED_PATH)
    const body = generated.replace("export const meta =", "const meta =")
    expect(() =>
      new Function(
        "args",
        "agent",
        "parallel",
        "pipeline",
        "phase",
        "log",
        "budget",
        "workflow",
        `return (async () => { ${body} })`,
      ),
    ).not.toThrow()
  })

  test("generated workflow inlines the merge brackets and the synthesis prompt", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain("function mergeFront")
    expect(generated).toContain("function mergeBack")
    expect(generated).toContain("function synthesisPrompt")
  })

  test("workflow meta is a pure literal (no computed values)", async () => {
    const fanout = await read(`${WF_DIR}/doc-review-fanout.js`)
    const metaBlock = fanout.slice(
      fanout.indexOf("export const meta = {"),
      fanout.indexOf("};", fanout.indexOf("export const meta = {")) + 2,
    )
    expect(metaBlock).not.toMatch(/\$\{/)
    expect(metaBlock).not.toMatch(/\.\.\./)
  })
})

// Regression guards for the three live-boundary contracts (none reachable below
// the live boundary, so pinned at source level) + the doc-review divergences.
describe("ce-doc-review workflow live-boundary contracts", () => {
  test("parses args delivered as a JSON string (not just an object)", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain('typeof A === "string"')
    expect(generated).toContain("JSON.parse(A)")
  })

  test("logs persona dispatch failures instead of silently dropping agents", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toMatch(/persona .* failed/)
  })

  test("logs synthesis-agent failure (the fourth, populated-but-absent surface)", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain("synthesis agent failed")
  })

  test("dispatches personas via the plugin-namespaced agentType passed in args", async () => {
    const fanout = await read(`${WF_DIR}/doc-review-fanout.js`)
    // The workflow passes through p.agentType (the orchestrator supplies the
    // compound-engineering:ce-*-reviewer form; bare ce-* does not resolve).
    expect(fanout).toContain("agentType: p.agentType")
  })

  test("dispatches exactly one synthesis agent, schema'd", async () => {
    const fanout = await read(`${WF_DIR}/doc-review-fanout.js`)
    expect(fanout).toContain("synthesisPrompt(front.findings)")
    expect(fanout).toContain("schema: SYNTHESIS_SCHEMA")
  })

  test("persona findings schema RETAINS why_it_matters + evidence (Key Decision 7)", async () => {
    const fanout = await read(`${WF_DIR}/doc-review-fanout.js`)
    const schemaBlock = fanout.slice(
      fanout.indexOf("const FINDINGS_SCHEMA"),
      fanout.indexOf("const SYNTHESIS_SCHEMA"),
    )
    // Unlike code-review's compact return, doc-review personas return FULL
    // findings — the synthesis agent needs why_it_matters for collapse,
    // contradiction, and chain linking.
    expect(schemaBlock).toContain("why_it_matters")
    expect(schemaBlock).toContain("evidence")
  })
})

// ---------------------------------------------------------------------------
// 2. Deterministic bracket parity (variance = 0, exact-assert on fixtures).
// ---------------------------------------------------------------------------

function f(overrides: Record<string, unknown> = {}) {
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
function ret(reviewer: string, findings: unknown[], extra: Record<string, unknown> = {}) {
  return { reviewer, findings, residual_risks: [], deferred_questions: [], ...extra }
}
function ann(overrides: Record<string, unknown> = {}) {
  return {
    id: "x",
    section: "S",
    title: "T",
    severity: "P1",
    finding_type: "error",
    why_it_matters: "w",
    evidence: ["e"],
    reviewers: ["coherence"],
    confidence: 75,
    autofix_class: "manual",
    recommended_action: "Defer",
    suggested_fix: null,
    depends_on: null,
    dependents: [],
    variant_count: 0,
    _order: 0,
    ...overrides,
  }
}

describe("deterministic brackets — variance = 0", () => {
  test("mergeFront is byte-identical across repeated runs on fixed input", () => {
    const input = [
      ret("coherence", [f({ section: "Summary", title: "a", confidence: 50, severity: "P0" })]),
      ret("feasibility", [f({ section: "Unit 2", title: "b", confidence: 75 })]),
    ]
    expect(JSON.stringify(mergeFront(input))).toBe(JSON.stringify(mergeFront(input)))
  })

  test("mergeBack is byte-identical across repeated runs on fixed input", () => {
    const input = [ann({ id: "a", _order: 0 }), ann({ id: "b", _order: 1, severity: "P0" })]
    const soft = { residual_risks: ["r"], deferred_questions: ["q"] }
    expect(JSON.stringify(mergeBack(input, soft))).toBe(JSON.stringify(mergeBack(input, soft)))
  })
})

describe("deterministic bracket behavior on planted cases", () => {
  test("cross-persona agreement: same fingerprint merges to one, keeping max anchor + both reviewers (3.4 promotion is agent-side)", () => {
    const out = mergeFront([
      ret("coherence", [f({ section: "Unit 4", title: "Deploy ordering", confidence: 75 })]),
      ret("feasibility", [f({ section: "Unit 4", title: "Deploy ordering", confidence: 100 })]),
    ])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0].confidence).toBe(100)
    expect(out.findings[0].reviewers).toEqual(["coherence", "feasibility"])
    expect(out.coverage.dedup_merged).toBe(1)
  })

  test("negative control: an injected malformed return drops exactly the malformed finding and records the producing persona", () => {
    const out = mergeFront([
      ret("coherence", [
        f({ section: "S1", title: "good", confidence: 100 }),
        { ...f({ section: "S2", title: "bad" }), confidence: 0.42 }, // float -> malformed
      ]),
      ret("feasibility", [f({ section: "S3", title: "other", confidence: 75 })]),
    ])
    expect(out.findings.map((x) => x.title).sort()).toEqual(["good", "other"])
    expect(out.coverage.dropped_findings).toBe(1)
    expect(out.coverage.malformed_agents).toEqual(["coherence"])
  })

  test("safety regression: a safe_auto-at-anchor-100 fix lands in the apply bucket (renamed fixes_to_apply in the envelope)", () => {
    const out = mergeBack(
      [ann({ id: "fix", confidence: 100, autofix_class: "safe_auto", suggested_fix: "Correct the count to 5." })],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.applied.map((x) => x.id)).toEqual(["fix"])
  })

  test("safety regression: a protected-artifact-deletion finding is dropped from every bucket", () => {
    const out = mergeBack(
      [
        ann({ id: "danger", confidence: 100, autofix_class: "gated_auto", suggested_fix: "Remove docs/plans/old.md, it is stale." }),
        ann({ id: "safe", confidence: 100, autofix_class: "manual" }),
      ],
      { residual_risks: [], deferred_questions: [] },
    )
    const all = [...out.applied, ...out.proposed_fixes, ...out.decisions, ...out.fyi].map((x) => x.id)
    expect(all).toContain("safe")
    expect(all).not.toContain("danger")
  })
})

// ---------------------------------------------------------------------------
// 3. Identity-level parity of the deterministic back-half — mergeBack must
//    preserve the synthesis agent's linkage annotations EXACTLY (not just
//    counts), so a correct synthesis result renders correctly. Ground truth is
//    the hand-built annotated set (one root + two dependents).
// ---------------------------------------------------------------------------

describe("identity-level parity (mergeBack preserves linkage, not just counts)", () => {
  const ROOT = "problem frame|rename premise unsupported"
  const D1 = "unit 2|alias mechanism unjustified"
  const D2 = "unit 3|aliasedcommand abstraction overkill"

  const chain = [
    ann({
      id: ROOT,
      section: "Problem Frame",
      title: "Rename premise unsupported",
      severity: "P0",
      autofix_class: "manual",
      confidence: 100,
      dependents: [D1, D2],
      _order: 0,
    }),
    ann({ id: D1, section: "Unit 2", title: "Alias mechanism unjustified", severity: "P1", autofix_class: "manual", confidence: 75, depends_on: ROOT, _order: 1 }),
    ann({ id: D2, section: "Unit 3", title: "AliasedCommand abstraction overkill", severity: "P2", autofix_class: "manual", confidence: 75, depends_on: ROOT, _order: 2 }),
  ]

  test("the specific root id and its exact dependents set survive into the decisions bucket", () => {
    const out = mergeBack(chain, { residual_risks: [], deferred_questions: [] })
    const root = out.decisions.find((x) => x.id === ROOT)
    expect(root).toBeDefined()
    expect(new Set(root!.dependents)).toEqual(new Set([D1, D2]))
  })

  test("each dependent's exact depends_on root id survives", () => {
    const out = mergeBack(chain, { residual_risks: [], deferred_questions: [] })
    const d1 = out.decisions.find((x) => x.id === D1)
    const d2 = out.decisions.find((x) => x.id === D2)
    expect(d1?.depends_on).toBe(ROOT)
    expect(d2?.depends_on).toBe(ROOT)
  })

  test("chains coverage counts the exact linked set (1 root / 2 dependents), not candidates", () => {
    const out = mergeBack(chain, { residual_risks: [], deferred_questions: [] })
    expect(out.coverage.chains).toEqual({ roots: 1, dependents: 2 })
  })

  test("reconciles inconsistent agent annotations: a dependent listed on a root but missing its depends_on back-pointer is NOT counted or nested (live-surfaced bug)", () => {
    // The synthesis agent listed d2 in the root's dependents array but left d2's
    // own depends_on null. Coverage (from depends_on) and rendering (from the
    // dependents array) would drift. mergeBack must reconcile to one source of
    // truth: rebuild dependents from depends_on back-pointers.
    const out = mergeBack(
      [
        ann({ id: "root", section: "Problem Frame", severity: "P0", autofix_class: "manual", confidence: 100, dependents: ["d1", "d2"], _order: 0 }),
        ann({ id: "d1", section: "Unit 2", severity: "P1", autofix_class: "manual", confidence: 75, depends_on: "root", _order: 1 }),
        ann({ id: "d2", section: "Unit 9", severity: "P2", autofix_class: "manual", confidence: 75, depends_on: null, _order: 2 }),
      ],
      { residual_risks: [], deferred_questions: [] },
    )
    const root = out.decisions.find((x) => x.id === "root")
    expect(root!.dependents).toEqual(["d1"]) // d2 dropped from the array (no back-pointer)
    expect(out.coverage.chains).toEqual({ roots: 1, dependents: 1 })
    // d2 still surfaces — at its own position, not nested, not lost.
    expect(out.decisions.map((x) => x.id)).toContain("d2")
    expect(out.decisions.find((x) => x.id === "d2")!.depends_on).toBeNull()
  })

  test("clears a depends_on whose root did not survive (e.g. protected-dropped) so it renders independently", () => {
    const out = mergeBack(
      [ann({ id: "orphan", autofix_class: "manual", confidence: 75, depends_on: "ghost-root" })],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.coverage.chains).toEqual({ roots: 0, dependents: 0 })
    expect(out.decisions.find((x) => x.id === "orphan")!.depends_on).toBeNull()
  })

  test("caps dependents at 6 per root; overflow lose their link and render independently", () => {
    const findings = [ann({ id: "root", severity: "P0", autofix_class: "manual", confidence: 100, _order: 0 })]
    for (let i = 0; i < 8; i++) {
      findings.push(ann({ id: "d" + i, section: "Unit " + i, severity: "P2", autofix_class: "manual", confidence: 75, depends_on: "root", _order: i + 1 }))
    }
    const out = mergeBack(findings, { residual_risks: [], deferred_questions: [] })
    const root = out.decisions.find((x) => x.id === "root")
    expect(root!.dependents).toHaveLength(6)
    expect(out.coverage.chains).toEqual({ roots: 1, dependents: 6 })
  })

  test("collapse parity: the surviving representative stays actionable; demoted variants (anchor 50) route to FYI", () => {
    // The synthesis agent keeps the strongest finding (variant_count records the
    // N-1 demoted) and demotes the rest to anchor 50. mergeBack must route the
    // kept one to an actionable bucket and the demoted variants to FYI.
    const out = mergeBack(
      [
        ann({ id: "kept", section: "Motivation", title: "Motivation weak", severity: "P1", autofix_class: "manual", confidence: 75, variant_count: 2 }),
        ann({ id: "v1", section: "Unit 4b", title: "Motivation weak (variant)", confidence: 50, autofix_class: "manual" }),
        ann({ id: "v2", section: "Key Technical Decisions", title: "Motivation weak (variant)", confidence: 50, autofix_class: "manual" }),
      ],
      { residual_risks: [], deferred_questions: [] },
    )
    expect(out.decisions.map((x) => x.id)).toContain("kept")
    expect(out.fyi.map((x) => x.id).sort()).toEqual(["v1", "v2"])
  })
})
