import { mkdtemp, readFile, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { transformContentForCodex } from "../src/utils/codex-content"
import { transformSkillContentForOpenCode } from "../src/converters/claude-to-opencode"
import { parseFrontmatter } from "../src/utils/frontmatter"
import { copySkillDir } from "../src/utils/files"

// U4 — the ce-doc-review skill must ship intact to non-Claude targets. The
// mode:headless workflow path is Claude-Code-only; the guard's prose fallback is
// the cross-platform safety net, so the converted SKILL.md must keep BOTH the
// guard reference and the prose fallback, the content transforms must not mangle
// either, and the isolated-unit copy must carry the workflows/ subdir verbatim.
//
// This file owns ONLY converter-copy + cross-platform portability. Build
// invariants and identity-level parity live in doc-review-workflow-eval.test.ts.

const SKILL_DIR = "plugins/compound-engineering/skills/ce-doc-review"
const SKILL = `${SKILL_DIR}/SKILL.md`

async function read(rel: string): Promise<string> {
  return readFile(path.join(process.cwd(), rel), "utf8")
}

describe("ce-doc-review workflow cross-platform portability", () => {
  test("skill is not platform-filtered (no ce_platforms restriction)", async () => {
    const content = await read(SKILL)
    const { data } = parseFrontmatter(content)
    // Unset means it ships to every target; [claude] would drop it from non-CC.
    expect(data.ce_platforms).toBeUndefined()
  })

  test("guard + fallback survive the Codex content transform", async () => {
    const out = transformContentForCodex(await read(SKILL))
    expect(out).toContain("workflows/doc-review-fanout.generated.js")
    expect(out).toContain("Workflow tool")
    expect(out).toContain("run the prose dispatch below") // fallback intact
    // The co-located path must not be rewritten into a prompt/skill reference.
    expect(out).not.toContain("/prompts:doc-review-fanout")
  })

  test("guard + fallback survive the OpenCode content transform", async () => {
    const out = transformSkillContentForOpenCode(await read(SKILL))
    expect(out).toContain("workflows/doc-review-fanout.generated.js")
    expect(out).toContain("Workflow tool")
    expect(out).toContain("run the prose dispatch below")
  })

  test("guard names the plugin-namespaced agentType (bare ce-* does not resolve in agent())", async () => {
    const content = await read(SKILL)
    expect(content).toContain("compound-engineering:ce-<name>-reviewer")
    expect(content).toContain("compound-engineering:ce-coherence-reviewer")
  })

  test("scriptPath resolution transfers: the guard reads the generated file and passes its contents as the Workflow script", async () => {
    const content = await read(SKILL)
    // Same mechanism the code-review conversion resolved: read the co-located
    // generated artifact, hand its contents to the Workflow tool as `script` —
    // not a skill-relative scriptPath (which would not resolve at install paths).
    expect(content).toContain("Read `workflows/doc-review-fanout.generated.js`")
    expect(content).toMatch(/`script` set to that file's contents/)
  })
})

// Converter copies the skill as an isolated unit — the workflows/ subdir (the
// template, the merge module, and the committed generated artifact) must come
// along verbatim, and the transformed SKILL.md must retain the prose fallback so
// a non-CC install runs the fallback synthesis path.
describe("ce-doc-review isolated-unit copy carries the workflows/ subdir", () => {
  let dest: string

  beforeAll(async () => {
    dest = await mkdtemp(path.join(tmpdir(), "doc-review-copy-"))
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
    const copied = await readFile(path.join(dest, "workflows/doc-review-fanout.generated.js"), "utf8")
    const source = await read(`${SKILL_DIR}/workflows/doc-review-fanout.generated.js`)
    expect(copied).toBe(source) // non-markdown files copied untouched
  })

  test("copies the pure merge module verbatim", async () => {
    const f = await stat(path.join(dest, "workflows/merge-doc-findings.js"))
    expect(f.isFile()).toBe(true)
  })

  test("the copied SKILL.md keeps the prose fallback self-contained", async () => {
    const skill = await readFile(path.join(dest, "SKILL.md"), "utf8")
    expect(skill).toContain("run the prose dispatch below")
    expect(skill).toContain("references/synthesis-and-presentation.md")
  })
})
