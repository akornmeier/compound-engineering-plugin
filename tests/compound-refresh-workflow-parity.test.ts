import { mkdtemp, readFile, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  assembleCorpusAuditWorkflow,
  GENERATED_PATH,
} from "../scripts/build-compound-refresh-workflow"
import { transformContentForCodex } from "../src/utils/codex-content"
import { transformSkillContentForOpenCode } from "../src/converters/claude-to-opencode"
import { parseFrontmatter } from "../src/utils/frontmatter"
import { copySkillDir } from "../src/utils/files"
import {
  AMBIGUITY_CONFIDENCE_THRESHOLD,
  CONTRADICTION_K,
  CONTRADICTION_CAP,
} from "../plugins/compound-engineering/skills/ce-compound-refresh/workflows/classify-rollup.js"

// U4 — build invariants, live-boundary source guards, and cross-platform
// portability for the ce-compound-refresh corpus-audit dynamic workflow.
//
// The workflow is Claude-Code-only; the guard's prose fallback is the
// cross-platform safety net. The live run (agents actually dispatching) is NOT
// assertable in `bun test` — it is the mandatory live-smoke acceptance gate
// (U6). What IS assertable here: the build contract (freshness, meta-first,
// syntax, inlined fns, the live-boundary contracts pinned at source level), the
// prose-fallback parity with the module's tuning constants, and that the
// converted skill ships intact with its fallback.

const SKILL_DIR = "plugins/compound-engineering/skills/ce-compound-refresh"
const SKILL = `${SKILL_DIR}/SKILL.md`
const WF_DIR = `${SKILL_DIR}/workflows`

async function read(rel: string): Promise<string> {
  return readFile(path.join(process.cwd(), rel), "utf8")
}

// ---------------------------------------------------------------------------
// Build / assembly invariants
// ---------------------------------------------------------------------------

describe("ce-compound-refresh workflow assembly", () => {
  test("the merge-module marker appears exactly once (no ambiguous match)", async () => {
    const fanout = await read(`${WF_DIR}/corpus-audit-fanout.js`)
    expect((fanout.match(/\/\* __MERGE_MODULE__ \*\//g) || []).length).toBe(1)
  })

  test("module exposes its functions via a strippable trailing export", async () => {
    const mod = await read(`${WF_DIR}/classify-rollup.js`)
    const stripped = mod.replace(/\nexport\s*\{[^}]*\};\s*$/, "\n")
    expect(stripped).not.toBe(mod) // the export line matched and was removed
    expect(stripped).not.toContain("export {")
    expect(stripped).toContain("function normalizeVerdict")
    expect(stripped).toContain("function rollupClassifications")
    expect(stripped).toContain("function buildClusters")
    expect(stripped).toContain("function contradictionTermination")
  })

  test("committed generated workflow is up to date with its sources", async () => {
    const committed = await read(GENERATED_PATH)
    const fresh = await assembleCorpusAuditWorkflow()
    // If this fails, run: bun run scripts/build-compound-refresh-workflow.ts
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

  test("generated workflow inlines the deterministic classify + roll-up functions", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain("function normalizeVerdict")
    expect(generated).toContain("function rollupClassifications")
    expect(generated).toContain("function buildClusters")
    expect(generated).toContain("function contradictionTermination")
  })

  test("workflow meta is a pure literal (no computed values)", async () => {
    const fanout = await read(`${WF_DIR}/corpus-audit-fanout.js`)
    const metaBlock = fanout.slice(
      fanout.indexOf("export const meta = {"),
      fanout.indexOf("};", fanout.indexOf("export const meta = {")) + 2,
    )
    expect(metaBlock).not.toMatch(/\$\{/)
    expect(metaBlock).not.toMatch(/\.\.\./)
  })
})

// ---------------------------------------------------------------------------
// Live-boundary contracts — none reachable below the live boundary, so pinned
// at source level (dynamic-workflow-conversion-live-boundary.md).
// ---------------------------------------------------------------------------

describe("ce-compound-refresh workflow live-boundary contracts", () => {
  test("parses args delivered as a JSON string (not just an object)", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain('typeof A === "string"')
    expect(generated).toContain("JSON.parse(A)")
  })

  test("logs classifier dispatch failures instead of silently dropping docs", async () => {
    const generated = await read(GENERATED_PATH)
    // A swallowed dispatch error reads as a doc that "classified Keep" — the
    // exact fail-open the safety invariant forbids.
    expect(generated).toMatch(/classify .* failed/)
    // No silent swallow that discards the error.
    expect(generated).not.toContain(".catch(() => null)")
  })

  test("dispatches schema-only on the default workflow subagent (no bare ce-* agentType)", async () => {
    const fanout = await read(`${WF_DIR}/corpus-audit-fanout.js`)
    // KTD7: default workflow subagent, model sonnet, no new ce-* agent. If an
    // agentType were ever added it must be plugin-namespaced (compound-engineering:),
    // never the bare ce-* form (which does not resolve in agent()).
    expect(fanout).toContain("schema: CLASSIFY_SCHEMA")
    expect(fanout).toContain('model: "sonnet"')
    expect(fanout).not.toMatch(/agentType:\s*["']ce-/)
  })

  test("inline agent() schemas contain no conditional JSON-schema keywords (KTD8)", async () => {
    const fanout = await read(`${WF_DIR}/corpus-audit-fanout.js`)
    // Both compact schemas live between CLASSIFY_SCHEMA and RUBRIC.
    const schemaBlock = fanout.slice(fanout.indexOf("const CLASSIFY_SCHEMA"), fanout.indexOf("const RUBRIC"))
    expect(schemaBlock).not.toContain("allOf")
    expect(schemaBlock).not.toContain("anyOf")
    expect(schemaBlock).not.toContain("oneOf")
    expect(schemaBlock).not.toMatch(/\bif\s*:/)
    expect(schemaBlock).not.toMatch(/\bthen\s*:/)
  })
})

// ---------------------------------------------------------------------------
// Cross-platform portability + converter-copy
// ---------------------------------------------------------------------------

describe("ce-compound-refresh workflow cross-platform portability", () => {
  test("skill is not platform-filtered (no ce_platforms restriction)", async () => {
    const { data } = parseFrontmatter(await read(SKILL))
    // Unset means it ships to every target; [claude] would drop it from non-CC.
    expect(data.ce_platforms).toBeUndefined()
  })

  test("guard + fallback survive the Codex content transform", async () => {
    const out = transformContentForCodex(await read(SKILL))
    expect(out).toContain("workflows/corpus-audit-fanout.generated.js")
    expect(out).toContain("Workflow tool")
    expect(out).toContain("run the prose dispatch below") // fallback intact
    // The co-located path must not be rewritten into a prompt/skill reference.
    expect(out).not.toContain("/prompts:corpus-audit-fanout")
  })

  test("guard + fallback survive the OpenCode content transform", async () => {
    const out = transformSkillContentForOpenCode(await read(SKILL))
    expect(out).toContain("workflows/corpus-audit-fanout.generated.js")
    expect(out).toContain("Workflow tool")
    expect(out).toContain("run the prose dispatch below")
  })

  test("scriptPath resolution transfers: the guard reads the generated file and passes its contents as the Workflow script", async () => {
    const content = await read(SKILL)
    expect(content).toContain("Read `workflows/corpus-audit-fanout.generated.js`")
    expect(content).toMatch(/`script` set to that file's contents/)
  })
})

// ---------------------------------------------------------------------------
// Prose-fallback parity — the loop-until-dry fallback cannot silently diverge
// from the module's branching, so the SKILL.md cites the module's exported
// tuning constants and termination decision-table identifiers verbatim (R9).
// ---------------------------------------------------------------------------

describe("ce-compound-refresh prose fallback cites the module's rules verbatim", () => {
  test("the tuning constants in SKILL.md match the module's exported values", async () => {
    const skill = await read(SKILL)
    expect(skill).toContain("`AMBIGUITY_CONFIDENCE_THRESHOLD` = " + AMBIGUITY_CONFIDENCE_THRESHOLD)
    expect(skill).toContain("`CONTRADICTION_K` = " + CONTRADICTION_K)
    expect(skill).toContain("`CONTRADICTION_CAP` = " + CONTRADICTION_CAP)
  })

  test("the termination decision-table identifiers appear in the fallback", async () => {
    const skill = await read(SKILL)
    expect(skill).toContain("dry_count")
    expect(skill).toContain("found_new")
    expect(skill).toContain("round_failed")
    // Both terminal statuses are represented in the table.
    expect(skill).toContain("complete")
    expect(skill).toContain("degraded")
  })

  test("the fallback names the canonical module as the single source of truth", async () => {
    const skill = await read(SKILL)
    expect(skill).toContain("classify-rollup.js")
  })
})

describe("ce-compound-refresh isolated-unit copy carries the workflows/ subdir", () => {
  let dest: string

  beforeAll(async () => {
    dest = await mkdtemp(path.join(tmpdir(), "compound-refresh-copy-"))
    await copySkillDir(
      path.join(process.cwd(), SKILL_DIR),
      dest,
      transformContentForCodex, // exercise the same transform a Codex install applies
    )
  })

  afterAll(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  test("copies the committed generated artifact verbatim", async () => {
    const copied = await readFile(path.join(dest, "workflows/corpus-audit-fanout.generated.js"), "utf8")
    const source = await read(`${WF_DIR}/corpus-audit-fanout.generated.js`)
    expect(copied).toBe(source) // non-markdown files copied untouched
  })

  test("copies the pure deterministic module verbatim", async () => {
    const f = await stat(path.join(dest, "workflows/classify-rollup.js"))
    expect(f.isFile()).toBe(true)
  })

  test("the copied SKILL.md keeps the prose fallback self-contained", async () => {
    const skill = await readFile(path.join(dest, "SKILL.md"), "utf8")
    expect(skill).toContain("run the prose dispatch below")
    expect(skill).toContain("classify-rollup.js")
  })
})
