import { readFile } from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { assembleReviewWorkflow, GENERATED_PATH } from "../scripts/build-review-workflow"
import { transformContentForCodex } from "../src/utils/codex-content"
import { transformSkillContentForOpenCode } from "../src/converters/claude-to-opencode"
import { parseFrontmatter } from "../src/utils/frontmatter"

// Verifies the ce-code-review dynamic-workflow ASSEMBLY contract without a live
// Workflow run. The Workflow runtime is self-contained (no sibling imports) and
// requires `export const meta` as the first statement, so the workflow is
// assembled at build time (scripts/build-review-workflow.ts) into a committed,
// runnable artifact that the SKILL.md mode:agent guard passes verbatim. These
// tests pin that contract; the live persona fan-out + output parity (U5) is
// validated separately in a deliberate run.

const WF_DIR = "plugins/compound-engineering/skills/ce-code-review/workflows"

async function read(rel: string): Promise<string> {
  return readFile(path.join(process.cwd(), rel), "utf8")
}

describe("ce-code-review workflow assembly", () => {
  test("the merge-module marker appears exactly once (no ambiguous match)", async () => {
    const fanout = await read(`${WF_DIR}/code-review-fanout.js`)
    const count = (fanout.match(/\/\* __MERGE_MODULE__ \*\//g) || []).length
    expect(count).toBe(1)
  })

  test("merge module exposes mergeFindings via a strippable trailing export", async () => {
    const merge = await read(`${WF_DIR}/merge-findings.js`)
    const stripped = merge.replace(/\nexport\s*\{[^}]*\};\s*$/, "\n")
    expect(stripped).not.toBe(merge) // the export line matched and was removed
    expect(stripped).not.toContain("export {")
    expect(stripped).toContain("function mergeFindings")
  })

  test("committed generated workflow is up to date with its sources", async () => {
    const committed = await read(GENERATED_PATH)
    const fresh = await assembleReviewWorkflow()
    // If this fails, run: bun run scripts/build-review-workflow.ts
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
    // Wrap top-level await/return + workflow globals; throws on any syntax error.
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

  test("generated workflow inlines merge, validation, and verdict logic", async () => {
    const generated = await read(GENERATED_PATH)
    expect(generated).toContain("function mergeFindings")
    expect(generated).toContain("function runValidation")
    expect(generated).toContain("function deriveVerdict")
  })

  test("workflow meta is a pure literal (no computed values)", async () => {
    const fanout = await read(`${WF_DIR}/code-review-fanout.js`)
    const metaBlock = fanout.slice(
      fanout.indexOf("export const meta = {"),
      fanout.indexOf("};", fanout.indexOf("export const meta = {")) + 2,
    )
    expect(metaBlock).not.toMatch(/\$\{/)
    expect(metaBlock).not.toMatch(/\.\.\./)
  })

  test("compact return schema omits detail-tier fields", async () => {
    const fanout = await read(`${WF_DIR}/code-review-fanout.js`)
    const schemaBlock = fanout.slice(
      fanout.indexOf("const COMPACT_SCHEMA"),
      fanout.indexOf("const VERDICT_SCHEMA"),
    )
    expect(schemaBlock).not.toContain("why_it_matters")
    expect(schemaBlock).not.toContain("evidence")
  })
})

// U4 — the skill must ship intact to non-Claude targets. The workflow path is
// Claude-Code-only; the guard's fallback is the cross-platform safety net, so
// the converted SKILL.md must keep BOTH the guard reference and the prose
// fallback, and the content transforms must not mangle either.
describe("ce-code-review workflow cross-platform portability", () => {
  const SKILL = `${WF_DIR.replace("/workflows", "")}/SKILL.md`

  test("skill is not platform-filtered (no ce_platforms restriction)", async () => {
    const content = await read(SKILL)
    const { data } = parseFrontmatter(content)
    // Unset means it ships to every target; [claude] would drop it from non-CC.
    expect(data.ce_platforms).toBeUndefined()
  })

  test("guard + fallback survive the Codex content transform", async () => {
    const content = await read(SKILL)
    const out = transformContentForCodex(content)
    expect(out).toContain("workflows/code-review-fanout.generated.js")
    expect(out).toContain("Workflow tool")
    expect(out).toContain("run the prose dispatch below") // fallback intact
    // The co-located path must not be rewritten into a prompt/skill reference.
    expect(out).not.toContain("/prompts:code-review-fanout")
  })

  test("guard + fallback survive the OpenCode content transform", async () => {
    const content = await read(SKILL)
    const out = transformSkillContentForOpenCode(content)
    expect(out).toContain("workflows/code-review-fanout.generated.js")
    expect(out).toContain("Workflow tool")
    expect(out).toContain("run the prose dispatch below")
  })
})
