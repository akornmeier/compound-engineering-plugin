import { readFile } from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"

// Verifies the ce-code-review dynamic-workflow ASSEMBLY contract without a live
// Workflow run. The Workflow runtime is self-contained (no sibling imports) and
// requires `export const meta` as the first statement, so the orchestrator
// assembles the script by inserting the canonical merge module at a marker.
// These tests pin that contract; the live persona fan-out + output parity (U5)
// is validated separately in a deliberate run.

const WF_DIR = "plugins/compound-engineering/skills/ce-code-review/workflows"
const MARKER = "/* __MERGE_MODULE__ */"

async function read(rel: string): Promise<string> {
  return readFile(path.join(process.cwd(), rel), "utf8")
}

/**
 * The canonical assembly the SKILL.md guard performs at invocation time:
 *   1. take merge-findings.js, drop its trailing `export { ... }` line,
 *   2. substitute it for the single merge-module marker in code-review-fanout.js.
 * Implemented with a function replacement so `$` in the inserted source (the
 * module's template literals) is treated literally.
 */
async function assemble(): Promise<string> {
  const merge = await read(`${WF_DIR}/merge-findings.js`)
  const fanout = await read(`${WF_DIR}/code-review-fanout.js`)
  const mergeInline = merge.replace(/\nexport\s*\{[^}]*\};\s*$/, "\n")
  return fanout.replace(MARKER, () => mergeInline)
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

  test("assembled script keeps `export const meta` as the first statement", async () => {
    const assembled = await assemble()
    const codeOnly = assembled
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
    expect(codeOnly[0].startsWith("export const meta")).toBe(true)
  })

  test("assembled script is syntactically valid JavaScript", async () => {
    const assembled = await assemble()
    const body = assembled.replace("export const meta =", "const meta =")
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

  test("assembled script inlines the merge logic and verdict derivation", async () => {
    const assembled = await assemble()
    expect(assembled).toContain("function mergeFindings")
    expect(assembled).toContain("function deriveVerdict")
  })

  test("workflow meta is a pure literal (no computed values)", async () => {
    const fanout = await read(`${WF_DIR}/code-review-fanout.js`)
    const metaBlock = fanout.slice(
      fanout.indexOf("export const meta = {"),
      fanout.indexOf("};", fanout.indexOf("export const meta = {")) + 2,
    )
    // No interpolation, function calls, or spreads in the meta literal.
    expect(metaBlock).not.toMatch(/\$\{/)
    expect(metaBlock).not.toMatch(/\.\.\./)
  })

  test("compact return schema omits detail-tier fields", async () => {
    const fanout = await read(`${WF_DIR}/code-review-fanout.js`)
    expect(fanout).toContain("COMPACT_SCHEMA")
    // Detail-tier fields live on disk, never in the compact return schema.
    const schemaBlock = fanout.slice(
      fanout.indexOf("const COMPACT_SCHEMA"),
      fanout.indexOf("// Shared review bundle"),
    )
    expect(schemaBlock).not.toContain("why_it_matters")
    expect(schemaBlock).not.toContain("evidence")
  })
})
