import { readFileSync } from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"

const TEMPLATE = path.join(
  __dirname,
  "../plugins/compound-engineering/skills/ce-learning-sweep/references/report-template.md"
)
const SKILL = path.join(
  __dirname,
  "../plugins/compound-engineering/skills/ce-learning-sweep/SKILL.md"
)

describe("learning-sweep keeper envelope: report-template.md field pins", () => {
  const template = readFileSync(TEMPLATE, "utf8")

  test("pins keeper_id field name", () => {
    expect(template).toContain("keeper_id")
  })

  test("pins anchor field name", () => {
    expect(template).toContain("`anchor`")
  })

  test("pins verdict field name", () => {
    expect(template).toContain("`verdict`")
  })

  test("pins overlapping_doc field name", () => {
    expect(template).toContain("`overlapping_doc`")
  })

  test("pins capture_fuel field name", () => {
    expect(template).toContain("`capture_fuel`")
  })
})

describe("learning-sweep keeper envelope: v1 terminal status lines still present", () => {
  const template = readFileSync(TEMPLATE, "utf8")

  test("pins swept-with-candidates status line prefix", () => {
    expect(template).toContain("status: swept — ")
  })

  test("pins swept-clean status line", () => {
    expect(template).toContain("status: swept clean — no candidate learnings")
  })

  test("pins skipped status line prefix", () => {
    expect(template).toContain("status: skipped — ")
  })
})

describe("learning-sweep keeper envelope: SKILL.md references keepers.json", () => {
  const skill = readFileSync(SKILL, "utf8")

  test("SKILL.md mentions keepers.json", () => {
    expect(skill).toContain("keepers.json")
  })
})
