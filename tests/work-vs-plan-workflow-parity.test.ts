import { readFile } from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import {
  assembleWorkVsPlanWorkflow,
  GENERATED_PATH,
} from "../scripts/build-work-vs-plan-workflow"

// U3 + U6 — build invariants and cross-platform portability for the
// ce-verify-work dynamic workflow.
//
// The workflow is Claude-Code-only; the guard's prose fallback is the
// cross-platform safety net. The live run (agents actually dispatching) is NOT
// assertable in `bun test` — it is the mandatory live-smoke acceptance gate
// (U5). What IS assertable here: the build contract (freshness, meta-first,
// syntax, inlined fns, the live-boundary contracts pinned at source level) — and
// (U6, below) that the converted skill ships intact with its fallback.

const SKILL_DIR = "plugins/compound-engineering/skills/ce-verify-work"
const WF_DIR = `${SKILL_DIR}/workflows`

async function read(rel: string): Promise<string> {
  return readFile(path.join(process.cwd(), rel), "utf8")
}

// ---------------------------------------------------------------------------
// U3 — build / assembly invariants
// ---------------------------------------------------------------------------

describe("ce-verify-work workflow assembly", () => {
  test("the merge-module marker appears exactly once (no ambiguous match)", async () => {
    const fanout = await read(`${WF_DIR}/work-vs-plan-fanout.js`)
    expect((fanout.match(/\/\* __MERGE_MODULE__ \*\//g) || []).length).toBe(1)
  })

  test("module exposes parsePlanUnits + rollupVerdicts via a strippable trailing export", async () => {
    const mod = await read(`${WF_DIR}/drift-rollup.js`)
    const stripped = mod.replace(/\nexport\s*\{[^}]*\};\s*$/, "\n")
    expect(stripped).not.toBe(mod) // the export line matched and was removed
    expect(stripped).not.toContain("export {")
    expect(stripped).toContain("function parsePlanUnits")
    expect(stripped).toContain("function rollupVerdicts")
  })

  test("committed generated workflow is up to date with its sources", async () => {
    const committed = await read(GENERATED_PATH)
    const fresh = await assembleWorkVsPlanWorkflow()
    // If this fails, run: bun run scripts/build-work-vs-plan-workflow.ts
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

  test("generated workflow inlines the deterministic parser + roll-up", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain("function parsePlanUnits")
    expect(generated).toContain("function rollupVerdicts")
  })

  test("workflow meta is a pure literal (no computed values)", async () => {
    const fanout = await read(`${WF_DIR}/work-vs-plan-fanout.js`)
    const metaBlock = fanout.slice(
      fanout.indexOf("export const meta = {"),
      fanout.indexOf("};", fanout.indexOf("export const meta = {")) + 2,
    )
    expect(metaBlock).not.toMatch(/\$\{/)
    expect(metaBlock).not.toMatch(/\.\.\./)
  })
})

// Regression guards for the live-boundary contracts (none reachable below the
// live boundary, so pinned at source level) + the ADR 0002 input contract.
describe("ce-verify-work workflow live-boundary contracts", () => {
  test("parses args delivered as a JSON string (not just an object)", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain('typeof A === "string"')
    expect(generated).toContain("JSON.parse(A)")
  })

  test("guards the input contract and short-circuits a malformed call (ADR 0002)", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain("function validateArgs")
    expect(generated).toContain("validateArgs(A)")
    expect(generated).toContain('status: "invalid_input"')
    expect(generated).toContain("invalidInputEnvelope")
    // Not the silent-default failure mode the live-boundary learning warns about.
    expect(generated).not.toContain('A.run_id || "unknown-run"')
  })

  test("structurally enforces a path-safe run_id and an absolute plan_path (ADR 0002)", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain("/^[A-Za-z0-9_-]+$/")
    expect(generated).toContain('.startsWith("/")')
  })

  test("requires plan_text in args (the runtime has no fs to read the plan itself)", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain("plan_text")
    expect(generated).toContain("parsePlanUnits(PLAN_TEXT)")
  })

  test("logs batch dispatch failures instead of silently dropping units", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toMatch(/classify batch .* failed/)
  })

  test("dispatches schema-only by default; passes agentType only when explicitly set", async () => {
    const fanout = await read(`${WF_DIR}/work-vs-plan-fanout.js`)
    // The default path is a general-purpose analysis agent (no agentType); a
    // dedicated classifier's agentType is opt-in and must be plugin-namespaced.
    expect(fanout).toContain("schema: VERDICT_SCHEMA")
    expect(fanout).toContain("...(AGENT_TYPE ? { agentType: AGENT_TYPE } : {})")
  })
})

// U6 extends this file with cross-platform portability + converter-copy
// assertions once SKILL.md exists (it reads SKILL.md, which lands in U4).
