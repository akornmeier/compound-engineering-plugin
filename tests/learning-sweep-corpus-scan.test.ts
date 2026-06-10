import { describe, expect, test } from "bun:test"
import { execSync } from "child_process"
import path from "path"

const SCRIPT = path.join(
  __dirname,
  "../plugins/compound-engineering/skills/ce-learning-sweep/scripts/scan-corpus.py"
)
const FIXTURES = path.join(__dirname, "fixtures/learning-sweep-corpus")
const REAL_CORPUS = path.join(__dirname, "../docs/solutions")

async function runScan(
  corpusDir?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ["python3", SCRIPT, ...(corpusDir ? [corpusDir] : [])]
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

function entryByPath(index: any[], rel: string): any {
  return index.find((e) => e.path === rel)
}

// ---------------------------------------------------------------------------
// Populated corpus: one scan exercises happy path + the heterogeneous edges
// the real corpus contains (category-only, created-instead-of-date, no
// frontmatter), all mirrored from real entries.
// ---------------------------------------------------------------------------
describe("scan-corpus populated fixture", () => {
  async function scanPopulated() {
    const { stdout, exitCode } = await runScan(
      path.join(FIXTURES, "populated")
    )
    expect(exitCode).toBe(0)
    return JSON.parse(stdout)
  }

  test("happy: well-formed entry indexed with all fields", async () => {
    const { index, warnings } = await scanPopulated()
    expect(warnings).toEqual([])
    const e = entryByPath(index, "well-formed.md")
    expect(e).toBeDefined()
    expect(e.title).toBe("Well-formed learning with every indexed field present")
    expect(e.module).toBe("plugins/compound-engineering/skills")
    expect(e.tags).toEqual(["skill-design", "corpus-scan", "well-formed"])
    expect(e.problem_type).toBe("design_pattern")
    expect(e.problem_type_key).toBe("problem_type")
    expect(e.date).toBe("2026-05-01")
  })

  test("edge: entry with category but no problem_type indexed without error", async () => {
    const { index } = await scanPopulated()
    const e = entryByPath(index, "nested/category-only.md")
    expect(e).toBeDefined()
    // category mapped in as problem_type, with the source key recorded.
    expect(e.problem_type).toBe("skill-design")
    expect(e.problem_type_key).toBe("category")
    expect(e.date).toBe("2026-03-17")
  })

  test("edge: entry with created: instead of date: captures the date", async () => {
    const { index } = await scanPopulated()
    const e = entryByPath(index, "created-date.md")
    expect(e).toBeDefined()
    expect(e.date).toBe("2026-03-15")
    // Flow-style tags parse too.
    expect(e.tags).toEqual([
      "codex",
      "converter",
      "skills",
      "prompts",
      "deprecation",
    ])
  })

  test("edge: file with no frontmatter gets a path/title-derived minimal record", async () => {
    const { index } = await scanPopulated()
    const e = entryByPath(index, "no-frontmatter.md")
    expect(e).toBeDefined()
    // Title derived from the first markdown heading.
    expect(e.title).toBe("Building Agent-Friendly CLIs: Practical Principles")
    // Missing fields are absent, not a dropped record.
    expect(e.module).toBeNull()
    expect(e.problem_type).toBeNull()
    expect(e.problem_type_key).toBeNull()
    expect(e.date).toBeNull()
    expect(e.tags).toEqual([])
  })

  test("every .md file is indexed, none dropped", async () => {
    const { index } = await scanPopulated()
    // 4 .md files in populated/ (one nested).
    expect(index.length).toBe(4)
    const paths = index.map((e: any) => e.path).sort()
    expect(paths).toEqual([
      "created-date.md",
      "nested/category-only.md",
      "no-frontmatter.md",
      "well-formed.md",
    ])
  })
})

// ---------------------------------------------------------------------------
// Empty and absent directories: both yield an empty index, exit 0.
// ---------------------------------------------------------------------------
describe("scan-corpus empty and absent", () => {
  test("edge: empty corpus directory -> empty index, exit 0", async () => {
    const { stdout, exitCode } = await runScan(path.join(FIXTURES, "empty"))
    expect(exitCode).toBe(0)
    const { index, warnings } = JSON.parse(stdout)
    expect(index).toEqual([])
    expect(warnings).toEqual([])
  })

  test("edge: directory absent entirely -> empty index, exit 0", async () => {
    const { stdout, exitCode } = await runScan(
      path.join(FIXTURES, "does-not-exist-xyz")
    )
    expect(exitCode).toBe(0)
    const { index, warnings } = JSON.parse(stdout)
    expect(index).toEqual([])
    expect(warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Malformed frontmatter: skipped with a warning, scan completes the rest.
// ---------------------------------------------------------------------------
describe("scan-corpus malformed frontmatter", () => {
  test("error: malformed frontmatter -> warning entry, scan completes", async () => {
    const { stdout, exitCode } = await runScan(
      path.join(FIXTURES, "malformed")
    )
    expect(exitCode).toBe(0)
    const { index, warnings } = JSON.parse(stdout)

    // The broken file is skipped from the index but recorded as a warning.
    expect(entryByPath(index, "broken-frontmatter.md")).toBeUndefined()
    expect(warnings.length).toBe(1)
    expect(warnings[0].path).toBe("broken-frontmatter.md")
    expect(warnings[0].reason).toContain("never closed")

    // The scan still completes: the healthy sibling is indexed.
    const healthy = entryByPath(index, "healthy.md")
    expect(healthy).toBeDefined()
    expect(healthy.problem_type).toBe("best_practice")
  })
})

// ---------------------------------------------------------------------------
// Real corpus: the script must index every .md under docs/solutions without
// dropping any — count match against a filesystem glob. This is the guard
// that a naive parser change can't silently corrupt corpus coverage.
// ---------------------------------------------------------------------------
describe("scan-corpus against the real docs/solutions corpus", () => {
  test("indexes every .md file without dropping any", async () => {
    const { stdout, exitCode } = await runScan(REAL_CORPUS)
    expect(exitCode).toBe(0)
    const { index, warnings } = JSON.parse(stdout)

    // Ground-truth count from the filesystem.
    const found = execSync(`find "${REAL_CORPUS}" -name '*.md' -type f | wc -l`)
      .toString()
      .trim()
    const expectedCount = parseInt(found, 10)
    expect(expectedCount).toBeGreaterThan(0)

    // Every real file is well-formed enough to index; none are dropped.
    expect(warnings).toEqual([])
    expect(index.length).toBe(expectedCount)

    // Sanity: the known no-frontmatter real entry is present (not dropped),
    // and a known category-only real entry maps category in.
    const noFm = entryByPath(index, "agent-friendly-cli-principles.md")
    expect(noFm).toBeDefined()
    expect(noFm.title).toBe("Building Agent-Friendly CLIs: Practical Principles")

    const categoryOnly = entryByPath(
      index,
      "skill-design/beta-skills-framework.md"
    )
    expect(categoryOnly).toBeDefined()
    expect(categoryOnly.problem_type_key).toBe("category")
  })
})
