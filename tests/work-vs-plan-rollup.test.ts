import { readFileSync } from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import {
  parsePlanUnits,
  rollupVerdicts,
} from "../plugins/compound-engineering/skills/ce-verify-work/workflows/drift-rollup.js"

const VERDICT_SCHEMA = JSON.parse(
  readFileSync(
    path.join(
      process.cwd(),
      "plugins/compound-engineering/skills/ce-verify-work/references/verdict-schema.json",
    ),
    "utf8",
  ),
)

// U1 — the pure deterministic module: a plan-unit parser and a verdict roll-up.
// Both are net-new ground for this repo and feed a numeric threshold, so they
// are the highest-value things to pin in isolation (variance = 0). The parser
// must read markdown AND HTML plans (ce-work reads both), ignore legacy
// checkbox marks, and preserve U-IDs verbatim. The roll-up must compute the
// drift rate over ATTEMPTED units only (done + drifted), excluding remaining
// and unverifiable from the denominator, and flag small/low-confidence samples.

const MD_PLAN = `# feat: example plan

## Summary

Some summary prose mentioning U1 and U3 inline (must not be parsed as units).

## Implementation Units

### U1. First unit

**Goal:** Do the first thing well.

**Dependencies:** none.

**Files:**
- \`src/a.js\` (new)
- \`tests/a.test.ts\` (new)

**Verification:** \`bun test\` green.

---

### U3. Second unit

**Goal:** Do the second thing.

**Files:**
- \`src/b.js\` (modified)

**Verification:** b works against the repo.

---

### U5. Third unit

**Goal:** Third thing.

**Files:**
- \`src/c.js\` (new)

**Verification:** c exists.

---

## Risk Analysis

Some risks.
`

describe("parsePlanUnits — markdown", () => {
  const units = parsePlanUnits(MD_PLAN)

  test("parses gapped U-IDs into units keyed by verbatim U-ID, no renumber", () => {
    expect(units.map((u) => u.u_id)).toEqual(["U1", "U3", "U5"])
  })

  test("extracts the unit name from the heading", () => {
    expect(units[0].name).toBe("First unit")
    expect(units[2].name).toBe("Third unit")
  })

  test("extracts the Goal text per unit", () => {
    expect(units[0].goal).toContain("Do the first thing well")
    expect(units[1].goal).toContain("Do the second thing")
  })

  test("extracts Verification text per unit", () => {
    expect(units[0].verification).toContain("bun test")
    expect(units[1].verification).toContain("b works against the repo")
  })

  test("splits Files into create / modify / test / all lists", () => {
    expect(units[0].files.create).toEqual(["src/a.js", "tests/a.test.ts"])
    expect(units[0].files.test).toEqual(["tests/a.test.ts"])
    expect(units[0].files.modify).toEqual([])
    expect(units[0].files.all).toEqual(["src/a.js", "tests/a.test.ts"])

    expect(units[1].files.modify).toEqual(["src/b.js"])
    expect(units[1].files.create).toEqual([])
    expect(units[1].files.all).toEqual(["src/b.js"])
  })

  test("does not parse inline U-references in prose as units", () => {
    // The Summary mentions "U1 and U3" inline — only ### headings are units.
    expect(units).toHaveLength(3)
  })
})

describe("parsePlanUnits — legacy checkbox marks are ignored, not read as state", () => {
  const CHECKBOX_PLAN = `## Implementation Units

### U1. [x] Done-looking unit

**Goal:** Should not be treated as done from the mark.

**Files:**
- \`src/x.js\` (new)

**Verification:** x exists.

### U2. [ ] Unchecked unit

**Goal:** Should not be treated as remaining from the mark.

**Files:**
- \`src/y.js\` (new)

**Verification:** y exists.
`
  const units = parsePlanUnits(CHECKBOX_PLAN)

  test("strips the checkbox token from the unit name", () => {
    expect(units.map((u) => u.u_id)).toEqual(["U1", "U2"])
    expect(units[0].name).toBe("Done-looking unit")
    expect(units[1].name).toBe("Unchecked unit")
  })

  test("the parsed unit carries no done/remaining state from the mark", () => {
    // The module returns plan structure only — no verdict/state field exists,
    // so a checkbox cannot leak into classification.
    expect(units[0]).not.toHaveProperty("verdict")
    expect(units[0]).not.toHaveProperty("done")
  })
})

describe("parsePlanUnits — HTML plan parsed equivalently to markdown", () => {
  // ce-plan emits HTML plans as <article> cards with a visible "U1." chip and a
  // <dl> metadata strip (<dt>Goal</dt><dd>...</dd>), Verification in a <details>.
  const HTML_PLAN = `<h2>Implementation Units</h2>
<article id="u1">
  <h3>U1. First unit</h3>
  <dl>
    <dt>Goal</dt><dd>Do the first thing well.</dd>
    <dt>Files</dt><dd><ul>
      <li><code>src/a.js</code> (new)</li>
      <li><code>tests/a.test.ts</code> (new)</li>
    </ul></dd>
  </dl>
  <details><summary>Verification</summary><p><code>bun test</code> green.</p></details>
</article>
<article id="u3">
  <h3>U3. Second unit</h3>
  <dl>
    <dt>Goal</dt><dd>Do the second thing.</dd>
    <dt>Files</dt><dd><ul><li><code>src/b.js</code> (modified)</li></ul></dd>
  </dl>
  <details><summary>Verification</summary><p>b works against the repo.</p></details>
</article>
`
  const units = parsePlanUnits(HTML_PLAN)

  test("extracts the same U-IDs as the markdown form", () => {
    expect(units.map((u) => u.u_id)).toEqual(["U1", "U3"])
  })

  test("extracts Goal, Files, and Verification from the HTML structure", () => {
    expect(units[0].name).toBe("First unit")
    expect(units[0].goal).toContain("Do the first thing well")
    expect(units[0].files.all).toEqual(["src/a.js", "tests/a.test.ts"])
    expect(units[0].files.test).toEqual(["tests/a.test.ts"])
    expect(units[0].verification).toContain("bun test")
    expect(units[1].files.modify).toEqual(["src/b.js"])
  })
})

describe("parsePlanUnits — empty / malformed plans", () => {
  test("a plan with no Implementation Units returns an empty set", () => {
    expect(parsePlanUnits("# Plan\n\n## Summary\n\nNo units here.\n")).toEqual([])
  })

  test("empty input returns an empty set, not a throw", () => {
    expect(parsePlanUnits("")).toEqual([])
    // @ts-expect-error — defensive: non-string input must not throw
    expect(parsePlanUnits(null)).toEqual([])
  })
})

describe("parsePlanUnits — Files skips non-path backtick tokens", () => {
  // Files blocks carry prose with inline code: globs, templated placeholders,
  // shell commands, and bare identifiers. Only real path-shaped tokens are files.
  const PLAN = `## Implementation Units

### U1. Unit with mixed backtick tokens in its Files block

**Goal:** Exercise the path-shape filter.

**Files:**
- \`src/real.js\` (new)
- **Conditional — only if the \`ce-*\` path is taken:** \`plugins/agents/ce-<name>.md\` (new) + a \`README.md\` row + a \`bun run release:validate\` pass
- \`tests/real.test.ts\` (new); must have no \`import\` of \`fs\`

**Verification:** real exists.
`
  const [u] = parsePlanUnits(PLAN)

  test("real path-shaped tokens are kept — including a later one on a mixed line", () => {
    expect(u.files.all).toContain("src/real.js")
    expect(u.files.all).toContain("README.md") // .md extension, after non-paths on the same line
    expect(u.files.all).toContain("tests/real.test.ts")
    expect(u.files.test).toContain("tests/real.test.ts")
  })

  test("globs, templated placeholders, commands, and bare words are skipped", () => {
    expect(u.files.all).not.toContain("ce-*") // glob
    expect(u.files.all).not.toContain("plugins/agents/ce-<name>.md") // <placeholder>
    expect(u.files.all).not.toContain("bun run release:validate") // command (has spaces)
    expect(u.files.all).not.toContain("import") // bare word, no path shape
    expect(u.files.all).not.toContain("fs")
  })
})

// ---------------------------------------------------------------------------
// rollupVerdicts — drift rate over attempted units, with the dilution and
// small-N guards the threshold depends on.
// ---------------------------------------------------------------------------

const ev = (s: string) => [s]

describe("rollupVerdicts — drift rate over attempted units", () => {
  test("rate = drifted / (done + drifted); remaining + unverifiable excluded", () => {
    const out = rollupVerdicts([
      { u_id: "U1", verdict: "done", evidence: ev("a") },
      { u_id: "U2", verdict: "done", evidence: ev("b") },
      { u_id: "U3", verdict: "remaining" },
      { u_id: "U4", verdict: "drifted", evidence: ev("c") },
      { u_id: "U5", verdict: "unverifiable", rationale: "behavioral claim" },
    ])
    expect(out.counts).toMatchObject({
      done: 2,
      remaining: 1,
      drifted: 1,
      unverifiable: 1,
      attempted: 3,
      dropped: 0,
    })
    expect(out.drift_rate).toBeCloseTo(1 / 3, 10)
  })

  test("the unverifiable subset is reported separately with its reason", () => {
    const out = rollupVerdicts([
      { u_id: "U1", verdict: "done", evidence: ev("a") },
      { u_id: "U5", verdict: "unverifiable", rationale: "improves latency" },
    ])
    expect(out.unverifiable).toEqual([{ u_id: "U5", reason: "improves latency" }])
  })

  test("empty attempted set yields drift_rate null, not a divide-by-zero", () => {
    const out = rollupVerdicts([
      { u_id: "U1", verdict: "remaining" },
      { u_id: "U2", verdict: "unverifiable", rationale: "runtime only" },
    ])
    expect(out.drift_rate).toBeNull()
    expect(out.counts.attempted).toBe(0)
  })

  test("attempted is the single source of truth: attempted === done + drifted", () => {
    const out = rollupVerdicts([
      { u_id: "U1", verdict: "done", evidence: ev("a") },
      { u_id: "U2", verdict: "drifted", evidence: ev("b") },
      { u_id: "U3", verdict: "remaining" },
    ])
    expect(out.counts.attempted).toBe(out.counts.done + out.counts.drifted)
  })
})

describe("rollupVerdicts — dilution and small-N guards", () => {
  test("timing-invariance: adding remaining units does not move the rate", () => {
    const base = [
      { u_id: "U1", verdict: "done", evidence: ev("a") },
      { u_id: "U2", verdict: "done", evidence: ev("b") },
      { u_id: "U3", verdict: "drifted", evidence: ev("c") },
    ]
    const diluted = [
      ...base,
      ...Array.from({ length: 10 }, (_, i) => ({ u_id: `R${i}`, verdict: "remaining" as const })),
    ]
    expect(rollupVerdicts(diluted).drift_rate).toBe(rollupVerdicts(base).drift_rate)
  })

  test("a small attempted set is flagged low_confidence; a healthy one is not", () => {
    const small = rollupVerdicts([
      { u_id: "U1", verdict: "done", evidence: ev("a") },
      { u_id: "U2", verdict: "drifted", evidence: ev("b") },
    ])
    expect(small.drift_rate).toBeCloseTo(0.5, 10)
    expect(small.low_confidence).toBe(true)

    const healthy = rollupVerdicts([
      { u_id: "U1", verdict: "done", evidence: ev("a") },
      { u_id: "U2", verdict: "done", evidence: ev("b") },
      { u_id: "U3", verdict: "drifted", evidence: ev("c") },
    ])
    expect(healthy.low_confidence).toBe(false)
  })

  test("a high unverifiable fraction flags the run low_confidence", () => {
    const out = rollupVerdicts([
      { u_id: "U1", verdict: "done", evidence: ev("a") },
      { u_id: "U2", verdict: "done", evidence: ev("b") },
      { u_id: "U3", verdict: "done", evidence: ev("c") },
      { u_id: "U4", verdict: "unverifiable", rationale: "behavioral" },
      { u_id: "U5", verdict: "unverifiable", rationale: "behavioral" },
      { u_id: "U6", verdict: "unverifiable", rationale: "behavioral" },
      { u_id: "U7", verdict: "unverifiable", rationale: "behavioral" },
    ])
    // attempted = 3 (>= floor), but 4/7 unverifiable is a low-confidence run.
    expect(out.low_confidence).toBe(true)
  })

  test("an all-remaining plan (attempted 0, total > 0) is the least-informative sample and is flagged", () => {
    const out = rollupVerdicts([
      { u_id: "U1", verdict: "remaining" },
      { u_id: "U2", verdict: "remaining" },
    ])
    expect(out.drift_rate).toBeNull()
    expect(out.low_confidence).toBe(true)
  })

  test("a genuinely empty result (no valid verdicts) is not flagged", () => {
    expect(rollupVerdicts([]).low_confidence).toBe(false)
    // an all-dropped set also has total 0 -> nothing to be confident or not about
    expect(rollupVerdicts([{ u_id: "", verdict: "done", evidence: ev("x") }]).low_confidence).toBe(false)
  })
})

describe("rollupVerdicts — validation drops malformed and uncited verdicts", () => {
  test("verdict not in the enum or missing u_id is dropped and counted", () => {
    const out = rollupVerdicts([
      { u_id: "U1", verdict: "bogus", evidence: ev("x") },
      { u_id: "", verdict: "done", evidence: ev("y") },
      { u_id: "U3", verdict: "done", evidence: ev("z") },
    ])
    expect(out.counts.dropped).toBe(2)
    expect(out.units.map((u) => u.u_id)).toEqual(["U3"])
    expect(out.counts.done).toBe(1)
  })

  test("done/drifted without non-empty evidence is dropped (Key Decision 5)", () => {
    const out = rollupVerdicts([
      { u_id: "U1", verdict: "done", evidence: [] },
      { u_id: "U2", verdict: "drifted" },
      { u_id: "U3", verdict: "remaining" },
    ])
    expect(out.counts.dropped).toBe(2)
    expect(out.counts.remaining).toBe(1)
    expect(out.counts.attempted).toBe(0)
    expect(out.drift_rate).toBeNull()
  })

  test("remaining and unverifiable may omit evidence and still survive", () => {
    const out = rollupVerdicts([
      { u_id: "U1", verdict: "remaining" },
      { u_id: "U2", verdict: "unverifiable", rationale: "runtime only" },
    ])
    expect(out.counts.dropped).toBe(0)
    expect(out.units).toHaveLength(2)
  })

  test("non-array input returns a zeroed roll-up, not a throw", () => {
    // @ts-expect-error — defensive
    const out = rollupVerdicts(null)
    expect(out.drift_rate).toBeNull()
    expect(out.counts.attempted).toBe(0)
    expect(out.units).toEqual([])
  })
})

describe("rollupVerdicts — determinism", () => {
  test("byte-identical output across repeated runs on a fixed verdict set", () => {
    const input = [
      { u_id: "U1", verdict: "done", evidence: ev("a") },
      { u_id: "U2", verdict: "drifted", evidence: ev("b") },
      { u_id: "U3", verdict: "remaining" },
      { u_id: "U4", verdict: "unverifiable", rationale: "behavioral" },
    ]
    expect(JSON.stringify(rollupVerdicts(input))).toBe(JSON.stringify(rollupVerdicts(input)))
  })
})

// U2 — the verdict-schema.json enum is the single source of truth shared with
// the U1 roll-up. This consistency check fails if the two drift apart.
describe("verdict-schema.json ↔ drift-rollup enum consistency", () => {
  const enumVals: string[] = VERDICT_SCHEMA.properties.verdict.enum

  test("schema enum is exactly the four verdicts", () => {
    expect([...enumVals].sort()).toEqual(["done", "drifted", "remaining", "unverifiable"])
  })

  test("every schema enum verdict is accepted by rollupVerdicts; a non-enum verdict is dropped", () => {
    for (const v of enumVals) {
      const out = rollupVerdicts([{ u_id: "U1", verdict: v, evidence: ev("e"), rationale: "r" }])
      expect(out.counts.dropped).toBe(0)
      expect(out.units).toHaveLength(1)
    }
    const bad = rollupVerdicts([{ u_id: "U1", verdict: "partial", evidence: ev("e") }])
    expect(bad.counts.dropped).toBe(1)
    expect(bad.units).toHaveLength(0)
  })

  test("schema requires non-empty evidence for done and drifted", () => {
    const cond = VERDICT_SCHEMA.allOf.find(
      (c: { if?: { properties?: { verdict?: { enum?: string[] } } } }) =>
        c.if?.properties?.verdict?.enum,
    )
    expect(new Set(cond.if.properties.verdict.enum)).toEqual(new Set(["done", "drifted"]))
    expect(cond.then.required).toContain("evidence")
    expect(cond.then.properties.evidence.minItems).toBe(1)
  })
})
