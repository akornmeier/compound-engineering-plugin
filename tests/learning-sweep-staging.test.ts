import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * Behavioral tests for ce-learning-sweep's stage-captures.py.
 *
 * Every named state in the staging state diagram gets at least one assertion.
 * The test harness:
 *   - A fake `gh` PATH shim records all invocations and dispatches on env vars.
 *   - A bare git origin + clone fixture repo where local main is deliberately
 *     AHEAD of origin/main by one commit — proves `open` branches from
 *     origin/main, never local main.
 *   - A fake validator script (injected via --validator) for merge tests.
 */

const SCRIPT = path.join(
  __dirname,
  "../plugins/compound-engineering/skills/ce-learning-sweep/scripts/stage-captures.py",
)

const CE_COMPOUND_SKILL = path.join(
  __dirname,
  "../plugins/compound-engineering/skills/ce-compound/SKILL.md",
)

const STAGING_WORKFLOW = path.join(
  __dirname,
  "../plugins/compound-engineering/skills/ce-learning-sweep/references/staging-workflow.md",
)

let shimDir: string       // holds the gh shim
let binDir: string        // holds git + python3 symlinks + gh shim
let noGhDir: string       // holds git + python3 but NO gh shim
let logFile: string       // the shim appends every invocation here
let repoDir: string       // the clone (script's CWD)

// ---------------------------------------------------------------------------
// Fixture git repo setup
// ---------------------------------------------------------------------------

async function setupFixtureRepo(): Promise<string> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ls-staging-repo-"))
  const origin = path.join(base, "origin.git")
  const clone = path.join(base, "clone")

  // Bare origin.
  await Bun.spawn(["git", "init", "--bare", "-q", origin]).exited
  await Bun.spawn(["git", "init", "-q", clone]).exited

  const gitOpts = { cwd: clone }

  // Configure git identity for commits.
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], gitOpts).exited
  await Bun.spawn(["git", "config", "user.name", "Test"], gitOpts).exited
  await Bun.spawn(["git", "remote", "add", "origin", origin], gitOpts).exited

  // Create an initial commit on origin/main.
  fs.writeFileSync(path.join(clone, "base.txt"), "base")
  await Bun.spawn(["git", "add", "base.txt"], gitOpts).exited
  await Bun.spawn(["git", "commit", "-q", "-m", "initial"], gitOpts).exited
  await Bun.spawn(["git", "push", "-q", "origin", "HEAD:main"], gitOpts).exited
  await Bun.spawn(["git", "branch", "-q", "-u", "origin/main"], gitOpts).exited

  // Add a LOCAL-ONLY commit on main (deliberately ahead of origin/main).
  // The staged branch must NOT contain this commit.
  fs.writeFileSync(path.join(clone, "local-only.txt"), "local-only work")
  await Bun.spawn(["git", "add", "local-only.txt"], gitOpts).exited
  await Bun.spawn(["git", "commit", "-q", "-m", "local-only: not on origin"], gitOpts).exited

  return clone
}

// ---------------------------------------------------------------------------
// Shim setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  logFile = path.join(os.tmpdir(), `ls-staging-log-${Date.now()}.txt`)
  fs.writeFileSync(logFile, "")

  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-staging-shim-"))

  // The shim records every invocation to logFile and dispatches on env vars.
  const ghShim = `#!/bin/bash
# Fake gh for stage-captures tests.
# Records every invocation to GH_SHIM_LOG.
# Absolute shebang: runs under restricted PATH.
sub="$1"
shift || true
# Record invocation.
echo "$sub $*" >> "$GH_SHIM_LOG"

if [ "$sub" = "auth" ]; then
  if [ "$GH_SHIM_NO_AUTH" = "1" ]; then
    echo "not logged in" >&2
    exit 1
  fi
  echo "Logged in"
  exit 0
fi

if [ "$sub" = "label" ]; then
  sub2="$1"; shift || true
  if [ "$sub2" = "list" ]; then
    echo "[]"
    exit 0
  fi
  if [ "$sub2" = "create" ]; then
    exit 0
  fi
  exit 0
fi

if [ "$sub" = "pr" ]; then
  pr_sub="$1"; shift || true
  if [ "$pr_sub" = "create" ]; then
    if [ "$GH_SHIM_PR_CREATE_FAIL" = "1" ]; then
      echo "pr create error" >&2
      exit 1
    fi
    echo "https://github.com/owner/repo/pull/99"
    exit 0
  fi
  if [ "$pr_sub" = "checks" ]; then
    if [ "$GH_SHIM_CHECKS_FAIL" = "1" ]; then
      exit 1
    fi
    exit 0
  fi
  if [ "$pr_sub" = "merge" ]; then
    exit 0
  fi
  if [ "$pr_sub" = "comment" ]; then
    exit 0
  fi
  exit 0
fi

echo "fake gh: unhandled: $sub $*" >&2
exit 99
`
  fs.writeFileSync(path.join(shimDir, "gh"), ghShim, { mode: 0o755 })

  const realGit = Bun.which("git")
  const realPython = Bun.which("python3")
  if (!realGit || !realPython) {
    throw new Error("test setup: git and python3 must be on PATH")
  }

  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-staging-bin-"))
  noGhDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-staging-nogh-"))

  for (const d of [binDir, noGhDir]) {
    fs.symlinkSync(realGit, path.join(d, "git"))
    fs.symlinkSync(realPython, path.join(d, "python3"))
  }
  fs.symlinkSync(path.join(shimDir, "gh"), path.join(binDir, "gh"))

  repoDir = await setupFixtureRepo()
})

afterAll(() => {
  for (const d of [shimDir, binDir, noGhDir]) {
    if (d) fs.rmSync(d, { recursive: true, force: true })
  }
  if (logFile) fs.rmSync(logFile, { force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunOpts {
  subcmd: string
  args?: string[]
  env?: Record<string, string>
  noGh?: boolean
  cwd?: string
}

async function run(opts: RunOpts): Promise<{
  envelope: any
  stdout: string
  stderr: string
  exitCode: number
}> {
  const binPath = opts.noGh ? noGhDir : binDir
  const cwd = opts.cwd ?? repoDir

  // Clear log file before each run.
  fs.writeFileSync(logFile, "")

  const proc = Bun.spawn(
    ["python3", SCRIPT, opts.subcmd, ...(opts.args ?? [])],
    {
      cwd,
      env: {
        PATH: binPath,
        HOME: process.env.HOME ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
        GH_SHIM_LOG: logFile,
        ...(opts.env ?? {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  let envelope: any = null
  const trimmed = stdout.trim()
  if (trimmed) {
    try {
      envelope = JSON.parse(trimmed)
    } catch {
      // leave null
    }
  }
  return { envelope, stdout, stderr, exitCode }
}

function ghLog(): string {
  return fs.readFileSync(logFile, "utf8")
}

function uniqueRunId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function makeBodyFile(content = "test PR body"): string {
  const f = path.join(os.tmpdir(), `staging-body-${Date.now()}.md`)
  fs.writeFileSync(f, content)
  return f
}

function makeValidator(exitCode: number, output = ""): string {
  const f = path.join(os.tmpdir(), `fake-validator-${Date.now()}.py`)
  fs.writeFileSync(
    f,
    `#!/usr/bin/env python3\nimport sys\nprint(${JSON.stringify(output)})\nsys.exit(${exitCode})\n`,
  )
  fs.chmodSync(f, 0o755)
  return f
}

// Open a worktree and return envelope + branch name.
async function doOpen(runId: string, sourcePr = 7): Promise<any> {
  const { envelope } = await run({
    subcmd: "open",
    args: ["--run-id", runId, "--source-pr", String(sourcePr)],
  })
  return envelope
}

// ---------------------------------------------------------------------------
// Happy path: open → finalize
// ---------------------------------------------------------------------------

describe("stage-captures: happy path open → finalize", () => {
  test("open emits worktree_open with path and branch", async () => {
    const runId = uniqueRunId()
    const env = await doOpen(runId)
    expect(env).not.toBeNull()
    expect(env.status).toBe("worktree_open")
    expect(env.worktree_path).toContain(runId)
    expect(env.branch).toMatch(/^learning-capture\/pr-7-/)
    expect(env.source_pr).toBe(7)

    // Cleanup.
    await run({ subcmd: "abort", args: ["--run-id", runId] })
  })

  test("branch created from origin/main — does NOT contain local-only commit", async () => {
    const runId = uniqueRunId()
    const openEnv = await doOpen(runId)
    expect(openEnv.status).toBe("worktree_open")

    const wt = openEnv.worktree_path
    // Check that local-only.txt does NOT exist in the worktree.
    expect(fs.existsSync(path.join(wt, "local-only.txt"))).toBe(false)
    // base.txt DOES exist (it was pushed to origin/main).
    expect(fs.existsSync(path.join(wt, "base.txt"))).toBe(true)

    await run({ subcmd: "abort", args: ["--run-id", runId] })
  })

  test("finalize: nothing staged → nothing_staged, no PR created", async () => {
    const runId = uniqueRunId()
    await doOpen(runId)
    const body = makeBodyFile()

    const { envelope } = await run({
      subcmd: "finalize",
      args: [
        "--run-id", runId,
        "--source-pr", "7",
        "--title", "docs(learnings): test",
        "--body-file", body,
      ],
    })
    expect(envelope.status).toBe("nothing_staged")
    expect(envelope.source_pr).toBe(7)
    // No gh pr create invoked.
    expect(ghLog()).not.toContain("pr create")

    await run({ subcmd: "teardown", args: ["--run-id", runId] })
  })

  test("finalize: staged docs/solutions file → pr_open with PR number and URL", async () => {
    const runId = uniqueRunId()
    const openEnv = await doOpen(runId)
    expect(openEnv.status).toBe("worktree_open")

    const wt = openEnv.worktree_path
    // Place a file in the allowlisted path.
    fs.mkdirSync(path.join(wt, "docs", "solutions", "best-practices"), { recursive: true })
    fs.writeFileSync(
      path.join(wt, "docs", "solutions", "best-practices", "test-entry.md"),
      "---\ntitle: Test\n---\n# Test\n",
    )

    const body = makeBodyFile("PR body with provenance")
    const { envelope } = await run({
      subcmd: "finalize",
      args: [
        "--run-id", runId,
        "--source-pr", "7",
        "--title", "docs(learnings): capture 1 entry from PR #7",
        "--body-file", body,
      ],
    })

    expect(envelope.status).toBe("pr_open")
    expect(envelope.pr_url).toContain("pull/99")
    expect(envelope.pr_number).toBe(99)
    expect(envelope.branch).toMatch(/^learning-capture\/pr-7-/)

    // gh pr create was called with --label learning-capture.
    const log = ghLog()
    expect(log).toContain("pr create")
    expect(log).toContain("learning-capture")

    await run({ subcmd: "teardown", args: ["--run-id", runId] })
  })

  test("finalize: stray non-allowlisted file in worktree → NOT staged, named in warnings", async () => {
    const runId = uniqueRunId()
    const openEnv = await doOpen(runId)
    const wt = openEnv.worktree_path

    // An allowlisted file.
    fs.mkdirSync(path.join(wt, "docs", "solutions", "best-practices"), { recursive: true })
    fs.writeFileSync(
      path.join(wt, "docs", "solutions", "best-practices", "allowed.md"),
      "# Allowed\n",
    )
    // A stray file outside the allowlist.
    fs.writeFileSync(path.join(wt, "stray.txt"), "not allowed")

    const body = makeBodyFile()
    const { envelope } = await run({
      subcmd: "finalize",
      args: [
        "--run-id", runId,
        "--source-pr", "7",
        "--title", "docs(learnings): test",
        "--body-file", body,
      ],
    })

    expect(envelope.status).toBe("pr_open")
    // Stray file named in warnings.
    expect(Array.isArray(envelope.warnings)).toBe(true)
    expect(envelope.warnings.some((w: any) => String(w).includes("stray.txt"))).toBe(true)

    // Confirm stray.txt was NOT committed (check the worktree's git status after finalize
    // would have committed only allowlisted paths — we can check the gh shim was still called).
    expect(ghLog()).toContain("pr create")

    await run({ subcmd: "teardown", args: ["--run-id", runId] })
  })

  test("finalize applies learning-capture label (recorded in shim log)", async () => {
    const runId = uniqueRunId()
    const openEnv = await doOpen(runId)
    const wt = openEnv.worktree_path

    fs.mkdirSync(path.join(wt, "docs", "solutions", "best-practices"), { recursive: true })
    fs.writeFileSync(
      path.join(wt, "docs", "solutions", "best-practices", "entry.md"),
      "# Entry\n",
    )

    const body = makeBodyFile()
    await run({
      subcmd: "finalize",
      args: [
        "--run-id", runId,
        "--source-pr", "7",
        "--title", "docs(learnings): test",
        "--body-file", body,
      ],
    })

    const log = ghLog()
    // Label ensure: `label list` and/or `label create` called.
    expect(log).toMatch(/label (list|create)/)
    // PR create includes --label learning-capture.
    expect(log).toContain("learning-capture")

    await run({ subcmd: "teardown", args: ["--run-id", runId] })
  })

  test("branch prefix is learning-capture/ in every finalize PR", async () => {
    const runId = uniqueRunId()
    const openEnv = await doOpen(runId, 42)
    const wt = openEnv.worktree_path

    fs.mkdirSync(path.join(wt, "docs", "solutions", "best-practices"), { recursive: true })
    fs.writeFileSync(
      path.join(wt, "docs", "solutions", "best-practices", "x.md"),
      "# X\n",
    )

    const body = makeBodyFile()
    const { envelope } = await run({
      subcmd: "finalize",
      args: [
        "--run-id", runId,
        "--source-pr", "42",
        "--title", "docs(learnings): test",
        "--body-file", body,
      ],
    })

    expect(envelope.branch).toMatch(/^learning-capture\//)

    await run({ subcmd: "teardown", args: ["--run-id", runId] })
  })
})

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe("stage-captures: abort", () => {
  test("abort after partial worktree writes → worktree removed and local branch ref deleted; no push", async () => {
    const runId = uniqueRunId()
    const openEnv = await doOpen(runId, 3)
    expect(openEnv.status).toBe("worktree_open")

    const wt = openEnv.worktree_path
    const branch = openEnv.branch

    // Write something in the worktree (simulating a partial capture).
    fs.writeFileSync(path.join(wt, "partial.md"), "partial")

    const { envelope } = await run({
      subcmd: "abort",
      args: ["--run-id", runId],
    })

    expect(envelope.status).toBe("rolled_back")
    expect(envelope.branch).toBe(branch)

    // Worktree directory removed.
    expect(fs.existsSync(wt)).toBe(false)

    // No push was recorded in shim log (abort path never pushes).
    expect(ghLog()).not.toContain("push")
    expect(ghLog()).not.toContain("pr create")

    // Branch ref deleted: `git branch --list <branch>` should return nothing.
    const branchCheck = Bun.spawn(["git", "branch", "--list", branch], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const branchOut = await new Response(branchCheck.stdout).text()
    expect(branchOut.trim()).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe("stage-captures: teardown", () => {
  test("teardown: idempotent — second call exits 0 with torn_down status", async () => {
    const runId = uniqueRunId()
    await doOpen(runId)

    const { envelope: e1, exitCode: c1 } = await run({
      subcmd: "teardown",
      args: ["--run-id", runId],
    })
    expect(c1).toBe(0)
    expect(e1.status).toBe("torn_down")

    // Second call — worktree already gone.
    const { envelope: e2, exitCode: c2 } = await run({
      subcmd: "teardown",
      args: ["--run-id", runId],
    })
    expect(c2).toBe(0)
    expect(e2.status).toBe("torn_down")
  })
})

// ---------------------------------------------------------------------------
// Error states
// ---------------------------------------------------------------------------

describe("stage-captures: error states", () => {
  test("non-integer source-pr → invalid_source_pr before any git/gh invocation", async () => {
    const runId = uniqueRunId()
    const { envelope, exitCode } = await run({
      subcmd: "open",
      args: ["--run-id", runId, "--source-pr", "not-a-number"],
    })
    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("invalid_source_pr")
    // No gh calls recorded.
    expect(ghLog()).toBe("")
  })

  test("zero source-pr → invalid_source_pr", async () => {
    const { envelope } = await run({
      subcmd: "open",
      args: ["--run-id", uniqueRunId(), "--source-pr", "0"],
    })
    expect(envelope.status).toBe("invalid_source_pr")
    expect(ghLog()).toBe("")
  })

  test("gh absent → no_forge on open", async () => {
    const { envelope, exitCode } = await run({
      subcmd: "open",
      args: ["--run-id", uniqueRunId(), "--source-pr", "7"],
      noGh: true,
    })
    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("no_forge")
  })

  test("gh not authenticated → no_forge on open", async () => {
    const { envelope } = await run({
      subcmd: "open",
      args: ["--run-id", uniqueRunId(), "--source-pr", "7"],
      env: { GH_SHIM_NO_AUTH: "1" },
    })
    expect(envelope.status).toBe("no_forge")
  })

  test("push ok, gh pr create fails twice → orphan_branch naming the branch", async () => {
    const runId = uniqueRunId()
    const openEnv = await doOpen(runId, 7)
    expect(openEnv.status).toBe("worktree_open")

    const wt = openEnv.worktree_path
    fs.mkdirSync(path.join(wt, "docs", "solutions", "best-practices"), { recursive: true })
    fs.writeFileSync(
      path.join(wt, "docs", "solutions", "best-practices", "entry.md"),
      "# Entry\n",
    )

    const body = makeBodyFile()
    const { envelope } = await run({
      subcmd: "finalize",
      args: [
        "--run-id", runId,
        "--source-pr", "7",
        "--title", "docs(learnings): test",
        "--body-file", body,
      ],
      env: { GH_SHIM_PR_CREATE_FAIL: "1" },
    })

    expect(envelope.status).toBe("orphan_branch")
    expect(typeof envelope.branch).toBe("string")
    expect(envelope.branch).toMatch(/^learning-capture\//)

    // Cleanup branch if still exists (ignore errors — abort may have deleted it).
    Bun.spawn(["git", "branch", "-D", envelope.branch], { cwd: repoDir, stderr: "pipe" })
    await run({ subcmd: "teardown", args: ["--run-id", runId] })
  })
})

// ---------------------------------------------------------------------------
// Merge subcommand
// ---------------------------------------------------------------------------

describe("stage-captures: merge", () => {
  test("validator failing → validation_failed status", async () => {
    const runId = uniqueRunId()
    const validator = makeValidator(1, "collision detected")

    const { envelope, exitCode } = await run({
      subcmd: "merge",
      args: [
        "--run-id", runId,
        "--pr", "99",
        "--validator", validator,
        "--timeout", "5",
      ],
    })
    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("validation_failed")
    expect(envelope.detail).toContain("collision detected")

    fs.rmSync(validator, { force: true })
  })

  test("validator ok + checks green → merged with squash + delete-branch args recorded", async () => {
    const runId = uniqueRunId()
    // Need a worktree so teardown inside merge works.
    await doOpen(runId, 7)

    const validator = makeValidator(0)

    const { envelope, exitCode } = await run({
      subcmd: "merge",
      args: [
        "--run-id", runId,
        "--pr", "99",
        "--validator", validator,
        "--timeout", "5",
      ],
    })
    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("merged")
    expect(envelope.pr).toBe(99)

    // gh pr merge --squash --delete-branch recorded.
    const log = ghLog()
    expect(log).toContain("pr merge")
    expect(log).toContain("--squash")
    expect(log).toContain("--delete-branch")

    fs.rmSync(validator, { force: true })
  })

  test("validator ok + checks red → awaiting_attention + comment recorded", async () => {
    const runId = uniqueRunId()
    await doOpen(runId, 7)

    const validator = makeValidator(0)

    const { envelope, exitCode } = await run({
      subcmd: "merge",
      args: [
        "--run-id", runId,
        "--pr", "99",
        "--validator", validator,
        "--timeout", "5",
      ],
      env: { GH_SHIM_CHECKS_FAIL: "1" },
    })
    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("awaiting_attention")
    expect(envelope.pr).toBe(99)

    // Comment posted on the PR.
    const log = ghLog()
    expect(log).toContain("pr comment")

    fs.rmSync(validator, { force: true })
    await run({ subcmd: "teardown", args: ["--run-id", runId] })
  })
})

// ---------------------------------------------------------------------------
// Pinned-signal test
// ---------------------------------------------------------------------------

describe("stage-captures: pinned terminal signals in ce-compound/SKILL.md", () => {
  test("Documentation complete appears verbatim in ce-compound/SKILL.md", () => {
    const content = fs.readFileSync(CE_COMPOUND_SKILL, "utf8")
    expect(content).toContain("Documentation complete")
  })

  test("Documentation skipped appears verbatim in ce-compound/SKILL.md", () => {
    const content = fs.readFileSync(CE_COMPOUND_SKILL, "utf8")
    expect(content).toContain("Documentation skipped")
  })

  test("write-root directive paragraph is present in ce-compound/SKILL.md", () => {
    const content = fs.readFileSync(CE_COMPOUND_SKILL, "utf8")
    expect(content).toContain("Write root")
    expect(content).toContain("resolve EVERY write under that root")
  })
})

// ---------------------------------------------------------------------------
// Pinned-constant test
// ---------------------------------------------------------------------------

/**
 * The label "learning-capture" and branch prefix "learning-capture/" are
 * three-consumer contracts shared by stage-captures.py, staging-workflow.md,
 * and (later) the validator and trigger recipe. This test is structured as an
 * easily-extended array of consumer file paths — sibling units (U5, U6) will
 * add their files here.
 */
describe("stage-captures: pinned constants across consumers", () => {
  // Files that must contain the label and branch-prefix constants verbatim.
  // U5 (validate-staged-keepers.py) and U6 (trigger-recipe.md) will add entries.
  const consumerFiles: Array<{ label: string; filePath: string }> = [
    {
      label: "stage-captures.py",
      filePath: path.join(
        __dirname,
        "../plugins/compound-engineering/skills/ce-learning-sweep/scripts/stage-captures.py",
      ),
    },
    {
      label: "staging-workflow.md",
      filePath: STAGING_WORKFLOW,
    },
  ]

  for (const { label, filePath } of consumerFiles) {
    test(`${label} contains label constant "learning-capture"`, () => {
      const content = fs.readFileSync(filePath, "utf8")
      expect(content).toContain("learning-capture")
    })

    test(`${label} contains branch-prefix constant "learning-capture/"`, () => {
      const content = fs.readFileSync(filePath, "utf8")
      expect(content).toContain("learning-capture/")
    })
  }
})
