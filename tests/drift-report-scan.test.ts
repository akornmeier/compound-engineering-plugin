import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

const SCRIPT = path.join(
  __dirname,
  "../plugins/compound-engineering/skills/ce-drift-report/scripts/scan-drift-events.py"
)

// Real drift-events dir for the live-run assertion
const REAL_EVENTS_DIR = path.join(__dirname, "../docs/drift-events")

async function runScan(
  eventsDir?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ["python3", SCRIPT, ...(eventsDir ? [eventsDir] : [])]
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeDriftEvent(opts: {
  plan: string
  runId: string
  date?: string
  drifted: string[]
  attempted: string[]
  lowConfidence?: boolean
  degraded?: boolean
}): string {
  const date = opts.date ?? "2026-06-01"
  const low = opts.lowConfidence ?? false
  const deg = opts.degraded ?? false
  const driftedList = opts.drifted.length
    ? `[${opts.drifted.join(", ")}]`
    : "[]"
  const attemptedList = opts.attempted.length
    ? `[${opts.attempted.join(", ")}]`
    : "[]"
  return `---
date: ${date}
plan: ${opts.plan}
run_id: ${opts.runId}
tags: [drift-event, work-vs-plan-verification, ce-verify-work]
---

# Drift event — ${opts.plan} (${opts.runId})

\`\`\`yaml
# machine-read block — copied verbatim from the envelope's grouped lists.
# The aggregation reads THIS; the rate is derived, never stored.
plan_path: docs/plans/${opts.plan}.md
run_id: ${opts.runId}
low_confidence: ${low}
degraded: ${deg}
drifted: ${driftedList}
attempted: ${attemptedList}
remaining: []
unverifiable: []
\`\`\`

## Cited evidence
${opts.attempted.map((u) => `- ${u} (${opts.drifted.includes(u) ? "drifted" : "done"}): evidence for ${u}`).join("\n")}
`
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "drift-report-test-"))
}

function writeEvent(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content, "utf-8")
}

// ---------------------------------------------------------------------------
// Happy path: three events across two plans
// ---------------------------------------------------------------------------
describe("happy path: three events across two plans", () => {
  const dir = makeTempDir()

  // Plan A: 2 events
  // Event 1: attempted=[U1, U2, U3], drifted=[U1]  -> rate 1/3
  writeEvent(
    dir,
    "plan-a--run-001.md",
    makeDriftEvent({
      plan: "plan-a",
      runId: "run-001",
      attempted: ["U1", "U2", "U3"],
      drifted: ["U1"],
    })
  )
  // Event 2: attempted=[U4, U5], drifted=[U4, U5]  -> rate 2/2
  writeEvent(
    dir,
    "plan-a--run-002.md",
    makeDriftEvent({
      plan: "plan-a",
      runId: "run-002",
      attempted: ["U4", "U5"],
      drifted: ["U4", "U5"],
    })
  )

  // Plan B: 1 event
  // Event 3: attempted=[U1, U2], drifted=[]  -> rate 0/2
  writeEvent(
    dir,
    "plan-b--run-003.md",
    makeDriftEvent({
      plan: "plan-b",
      runId: "run-003",
      attempted: ["U1", "U2"],
      drifted: [],
    })
  )

  test("exits 0 and status ok", async () => {
    const { exitCode, stdout } = await runScan(dir)
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.status).toBe("ok")
  })

  test("events_scanned is 3", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    expect(result.events_scanned).toBe(3)
  })

  test("per-plan rate for plan-a: 3 drifted / 5 attempted", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    const pa = result.per_plan["plan-a"]
    expect(pa).toBeDefined()
    expect(pa.attempted).toBe(5)
    expect(pa.drifted).toBe(3)
    // rate = 3/5 = 0.6
    expect(pa.rate).toBeCloseTo(0.6, 5)
    expect(pa.events).toBe(2)
  })

  test("per-plan rate for plan-b: 0 drifted / 2 attempted", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    const pb = result.per_plan["plan-b"]
    expect(pb).toBeDefined()
    expect(pb.attempted).toBe(2)
    expect(pb.drifted).toBe(0)
    expect(pb.rate).toBeCloseTo(0.0, 5)
    expect(pb.events).toBe(1)
  })

  test("cross-plan aggregate: 3 drifted / 7 attempted", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    const cp = result.cross_plan
    expect(cp.attempted).toBe(7)
    expect(cp.drifted).toBe(3)
    expect(cp.rate).toBeCloseTo(3 / 7, 5)
    expect(cp.events).toBe(3)
  })

  test("warnings empty", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    expect(result.warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Zero events / directory absent -> no_drift_data, exit 0
// ---------------------------------------------------------------------------
describe("zero events / directory absent", () => {
  test("absent directory -> no_drift_data, exit 0", async () => {
    const absentDir = path.join(os.tmpdir(), "drift-report-absent-xyz-999")
    const { stdout, exitCode } = await runScan(absentDir)
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.status).toBe("no_drift_data")
    expect(result.events_dir_found).toBe(false)
    expect(result.events_scanned).toBe(0)
    expect(result.cross_plan.events).toBe(0)
  })

  test("empty directory -> no_drift_data, exit 0", async () => {
    const emptyDir = makeTempDir()
    const { stdout, exitCode } = await runScan(emptyDir)
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.status).toBe("no_drift_data")
    expect(result.events_dir_found).toBe(true)
    expect(result.events_scanned).toBe(0)
  })

  test("README.md only (excluded) -> no_drift_data", async () => {
    const dir = makeTempDir()
    fs.writeFileSync(path.join(dir, "README.md"), "# Drift events\n", "utf-8")
    const { stdout, exitCode } = await runScan(dir)
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.status).toBe("no_drift_data")
  })
})

// ---------------------------------------------------------------------------
// attempted: [] event excluded from denominators, counted in coverage
// ---------------------------------------------------------------------------
describe("event with attempted: [] excluded from denominators", () => {
  const dir = makeTempDir()

  // Event with data: 2 attempted, 1 drifted
  writeEvent(
    dir,
    "plan-x--run-001.md",
    makeDriftEvent({
      plan: "plan-x",
      runId: "run-001",
      attempted: ["U1", "U2"],
      drifted: ["U1"],
    })
  )
  // Event with empty attempted — counts in coverage, not denominator
  writeEvent(
    dir,
    "plan-x--run-002.md",
    makeDriftEvent({
      plan: "plan-x",
      runId: "run-002",
      attempted: [],
      drifted: [],
    })
  )

  test("events_scanned counts both events", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    expect(result.events_scanned).toBe(2)
    expect(result.per_plan["plan-x"].events).toBe(2)
  })

  test("attempted=[] event excluded from rate denominator", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    const px = result.per_plan["plan-x"]
    // Only the 2 attempted from run-001 count
    expect(px.attempted).toBe(2)
    expect(px.drifted).toBe(1)
    expect(px.rate).toBeCloseTo(0.5, 5)
  })

  test("cross-plan only counts the non-zero event", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    expect(result.cross_plan.attempted).toBe(2)
    expect(result.cross_plan.drifted).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Malformed YAML block in one event -> warning, rest aggregate correctly
// ---------------------------------------------------------------------------
describe("malformed YAML block in one event", () => {
  const dir = makeTempDir()

  // One good event
  writeEvent(
    dir,
    "plan-y--run-001.md",
    makeDriftEvent({
      plan: "plan-y",
      runId: "run-001",
      attempted: ["U1"],
      drifted: [],
    })
  )

  // One event with no fenced yaml block (malformed)
  writeEvent(
    dir,
    "plan-y--run-bad.md",
    `---
date: 2026-06-01
plan: plan-y
run_id: run-bad
tags: [drift-event]
---

# Drift event

This file has no fenced yaml block at all — just prose.
`
  )

  test("exit 0 and status ok (not no_drift_data)", async () => {
    const { stdout, exitCode } = await runScan(dir)
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.status).toBe("ok")
  })

  test("warning recorded for malformed event", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0].file).toBe("plan-y--run-bad.md")
    expect(result.warnings[0].reason).toContain("yaml")
  })

  test("good event still aggregated correctly", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    // Only the good event contributes
    expect(result.events_scanned).toBe(1)
    const py = result.per_plan["plan-y"]
    expect(py).toBeDefined()
    expect(py.attempted).toBe(1)
    expect(py.drifted).toBe(0)
    expect(py.rate).toBeCloseTo(0.0, 5)
  })
})

// ---------------------------------------------------------------------------
// AE6: low-confidence run included, flagged — no rate stored anywhere
// ---------------------------------------------------------------------------
describe("AE6: low-confidence run included and flagged", () => {
  const dir = makeTempDir()

  // Low-confidence event
  writeEvent(
    dir,
    "plan-z--run-lc.md",
    makeDriftEvent({
      plan: "plan-z",
      runId: "run-lc",
      attempted: ["U1", "U2"],
      drifted: ["U2"],
      lowConfidence: true,
    })
  )

  // Degraded event
  writeEvent(
    dir,
    "plan-z--run-deg.md",
    makeDriftEvent({
      plan: "plan-z",
      runId: "run-deg",
      attempted: ["U3"],
      drifted: [],
      degraded: true,
    })
  )

  // Normal event
  writeEvent(
    dir,
    "plan-z--run-normal.md",
    makeDriftEvent({
      plan: "plan-z",
      runId: "run-normal",
      attempted: ["U4", "U5"],
      drifted: [],
    })
  )

  test("all three events included in events_scanned", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    expect(result.events_scanned).toBe(3)
  })

  test("flagged_count reflects low-confidence + degraded", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    expect(result.flagged_count).toBe(2)
  })

  test("per-plan flagged count", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    const pz = result.per_plan["plan-z"]
    expect(pz.flagged).toBe(2)
  })

  test("flagged events contribute to rate denominator (not dropped)", async () => {
    const { stdout } = await runScan(dir)
    const result = JSON.parse(stdout)
    const pz = result.per_plan["plan-z"]
    // attempted = 2 (lc) + 1 (deg) + 2 (normal) = 5
    // drifted = 1 (lc)
    expect(pz.attempted).toBe(5)
    expect(pz.drifted).toBe(1)
    expect(pz.rate).toBeCloseTo(1 / 5, 5)
  })

  test("script writes no files — events dir unchanged after run", async () => {
    const filesBefore = fs.readdirSync(dir).sort()
    await runScan(dir)
    const filesAfter = fs.readdirSync(dir).sort()
    expect(filesAfter).toEqual(filesBefore)
  })

  test("no rate value is stored in the JSON envelope", async () => {
    const { stdout } = await runScan(dir)
    // Verify the raw JSON text does not contain a stored `drift_rate` key
    expect(stdout).not.toContain('"drift_rate"')
  })
})

// ---------------------------------------------------------------------------
// Live run against the repo's real docs/drift-events/
// ---------------------------------------------------------------------------
describe("live run against real docs/drift-events", () => {
  test("exits 0 and emits valid JSON", async () => {
    const { stdout, exitCode } = await runScan(REAL_EVENTS_DIR)
    expect(exitCode).toBe(0)
    // Must be valid JSON with a status field
    const result = JSON.parse(stdout)
    expect(["ok", "no_drift_data"]).toContain(result.status)
    expect(typeof result.events_scanned).toBe("number")
    expect(Array.isArray(result.warnings)).toBe(true)
  })
})
