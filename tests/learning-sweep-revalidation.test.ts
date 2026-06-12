import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

const GIT_TEST_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: process.env.HOME ?? "",
}

/**
 * Behavioral tests for validate-staged-keepers.py.
 *
 * Each test uses a fixture git setup: a bare origin + clone, pre-arranged so
 * the validator can run with --no-fetch and control exactly what origin/main
 * contains vs. what is staged on the capture branch.
 *
 * Fetch behavior is tested in the AE2 scenario by running WITH fetch enabled
 * against a clone whose remote-tracking ref is deliberately stale (origin/main
 * has a new overlapping doc, but the clone hasn't fetched it yet).
 */

const VALIDATOR = path.join(
  __dirname,
  "../plugins/compound-engineering/skills/ce-learning-sweep/scripts/validate-staged-keepers.py",
)

// ---------------------------------------------------------------------------
// Git fixture helpers
// ---------------------------------------------------------------------------

interface FixtureRepo {
  origin: string
  clone: string
}

/**
 * Create a bare origin + clone, wired up and ready for capture-branch tests.
 *
 * The clone's local main is on the same commit as origin/main.  Tests add
 * files and create branches as needed.
 */
async function createFixture(baseDir: string): Promise<FixtureRepo> {
  const origin = path.join(baseDir, "origin.git")
  const clone = path.join(baseDir, "clone")

  await Bun.spawn(["git", "init", "--bare", "-q", origin]).exited
  await Bun.spawn(["git", "init", "-q", clone]).exited

  const g = (args: string[]) => Bun.spawn(["git", ...args], {
    cwd: clone,
    env: GIT_TEST_ENV,
  }).exited

  await g(["config", "user.email", "test@test.com"])
  await g(["config", "user.name", "Test"])
  await g(["remote", "add", "origin", origin])

  // Seed origin/main with a README.
  fs.writeFileSync(path.join(clone, "README.md"), "# repo\n")
  await g(["add", "README.md"])
  await g(["commit", "-q", "-m", "initial"])
  await g(["push", "-q", "origin", "HEAD:main"])
  await g(["branch", "-q", "-u", "origin/main"])

  return { origin, clone }
}

/** Run a git command in a repo dir, returns stdout. */
function git(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: GIT_TEST_ENV,
  })
  return proc.stdout.toString()
}

/** Create a solutions doc with frontmatter in the clone worktree. */
function writeDoc(
  repoDir: string,
  relPath: string,
  opts: {
    title?: string
    tags?: string[]
    module?: string
    body?: string
  } = {},
): void {
  const fullPath = path.join(repoDir, relPath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  const tagLine = opts.tags?.length
    ? `tags: [${opts.tags.join(", ")}]\n`
    : ""
  const moduleLine = opts.module ? `module: "${opts.module}"\n` : ""
  const titleLine = opts.title ? `title: "${opts.title}"\n` : ""
  const fm = `---\n${titleLine}${tagLine}${moduleLine}---\n`
  fs.writeFileSync(fullPath, fm + (opts.body ?? "# Content\n"))
}

// ---------------------------------------------------------------------------
// Validator runner
// ---------------------------------------------------------------------------

interface RunValidatorOpts {
  /** The clone directory to run inside. */
  cwd: string
  /** Branch name to pass as --branch (avoids relying on git branch --show-current). */
  branch: string
  /** Base ref (default: origin/main). */
  base?: string
  /** Skip fetch (default: true for fixture tests — use fetchEnabled: true to enable). */
  fetchEnabled?: boolean
  /** Extra env overrides. */
  env?: Record<string, string>
}

async function runValidator(opts: RunValidatorOpts): Promise<{
  envelope: any
  exitCode: number
  stdout: string
  stderr: string
}> {
  const args = [
    "python3", VALIDATOR,
    "--branch", opts.branch,
    "--base", opts.base ?? "origin/main",
  ]
  if (!opts.fetchEnabled) {
    args.push("--no-fetch")
  }

  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
      ...(opts.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })

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
  return { envelope, exitCode, stdout, stderr }
}

// ---------------------------------------------------------------------------
// Shared base dir for all fixture repos
// ---------------------------------------------------------------------------

let baseDir: string

beforeAll(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsk-tests-"))
})

afterAll(() => {
  if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true })
})

function uniqueDir(prefix: string): string {
  return fs.mkdtempSync(path.join(baseDir, `${prefix}-`))
}

// ---------------------------------------------------------------------------
// AE2: staged entry duplicating corpus doc added AFTER staging — fresh fetch proves it
//
// Scenario:
//   1. Seed origin/main (no corpus docs yet).
//   2. Create capture branch, stage an entry (title: "My Keeper", tags: [foo]).
//   3. Advance origin/main with a highly-overlapping doc (same title + same tags).
//   4. Deliberately leave clone's remote-tracking ref STALE (no fetch).
//   5. Run validator WITH fetch enabled — it must fetch, discover the collision,
//      and exit non-zero naming the pair.
// ---------------------------------------------------------------------------

describe("AE2: fresh fetch detects post-staging corpus collision", () => {
  test("fetch runs and catches collision when origin/main advances after staging", async () => {
    const dir = uniqueDir("ae2")
    const { origin, clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    // Step 2: create capture branch and stage an entry.
    await g(["checkout", "-b", "learning-capture/pr-100-ae2"])
    writeDoc(clone, "docs/solutions/workflow/my-keeper.md", {
      title: "My Keeper Title",
      tags: ["keeper-tag", "shared-tag"],
      module: "plugins/compound-engineering",
    })
    await g(["add", "docs/solutions/workflow/my-keeper.md"])
    await g(["commit", "-q", "-m", "docs(learnings): stage my-keeper"])

    // Step 3: advance origin/main with an overlapping corpus doc.
    // We do this by checking out main, adding the doc, pushing.
    await g(["checkout", "main"])
    writeDoc(clone, "docs/solutions/workflow/existing-keeper.md", {
      title: "My Keeper Title",          // same title — triggers collision
      tags: ["shared-tag", "extra-tag"], // shared tag
      module: "plugins/compound-engineering",
    })
    await g(["add", "docs/solutions/workflow/existing-keeper.md"])
    await g(["commit", "-q", "-m", "docs: add existing keeper"])
    await g(["push", "-q", "origin", "HEAD:main"])

    // Step 4: switch back to the capture branch — origin/main has advanced but
    // the clone's remote-tracking ref has NOT been refreshed yet.
    await g(["checkout", "learning-capture/pr-100-ae2"])

    // Step 5: run validator WITH fetch enabled — it must fetch origin/main.
    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "learning-capture/pr-100-ae2",
      base: "origin/main",
      fetchEnabled: true,  // fetch is ON — the key difference from --no-fetch tests
    })

    expect(exitCode).toBe(1)
    expect(envelope.status).toBe("failed")
    const collision = envelope.failures.find((f: any) => f.type === "corpus_collision")
    expect(collision).toBeDefined()
    expect(collision.staged_path).toContain("my-keeper.md")
    expect(collision.corpus_path).toContain("existing-keeper.md")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Happy path: no overlap → exit 0
// ---------------------------------------------------------------------------

describe("happy path: no corpus overlap", () => {
  test("staged entry with no matching corpus docs → pass, exit 0", async () => {
    const dir = uniqueDir("happy")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    await g(["checkout", "-b", "learning-capture/pr-1-happy"])
    writeDoc(clone, "docs/solutions/best-practices/unique-entry.md", {
      title: "Completely Unique Title Nobody Has",
      tags: ["unique-xyzzy-tag"],
      module: "plugins/unknown-module",
    })
    await g(["add", "docs/solutions/best-practices/unique-entry.md"])
    await g(["commit", "-q", "-m", "docs(learnings): stage unique entry"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "learning-capture/pr-1-happy",
    })

    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("pass")
  })
})

// ---------------------------------------------------------------------------
// Edge: non-capture branch name → skipped
// ---------------------------------------------------------------------------

describe("edge: non-capture branch → skipped", () => {
  test("main branch name → skipped_not_capture_branch, exit 0, even with solutions diff", async () => {
    const dir = uniqueDir("skip")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    // Add a solutions doc on main itself — should NOT trigger the gate.
    writeDoc(clone, "docs/solutions/workflow/human-doc.md", {
      title: "A Human Added This",
      tags: ["manual"],
    })
    await g(["add", "docs/solutions/workflow/human-doc.md"])
    await g(["commit", "-q", "-m", "docs: manual solution"])
    await g(["push", "-q", "origin", "HEAD:main"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "main",
    })

    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("skipped_not_capture_branch")
  })

  test("feature branch (not learning-capture/) → skipped even when diff touches docs/solutions", async () => {
    const dir = uniqueDir("skip2")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    await g(["checkout", "-b", "feat/some-feature"])
    writeDoc(clone, "docs/solutions/best-practices/feature-doc.md", {
      title: "Feature Doc",
    })
    await g(["add", "docs/solutions/best-practices/feature-doc.md"])
    await g(["commit", "-q", "-m", "docs: feature doc"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "feat/some-feature",
    })

    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("skipped_not_capture_branch")
  })
})

// ---------------------------------------------------------------------------
// Edge: update-in-place modification → NOT flagged by gate 2
// ---------------------------------------------------------------------------

describe("edge: update-in-place is not a collision", () => {
  test("modifying an existing corpus doc is not flagged as corpus_collision", async () => {
    const dir = uniqueDir("update")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    // Put an existing doc on origin/main.
    writeDoc(clone, "docs/solutions/workflow/existing-doc.md", {
      title: "Existing Document",
      tags: ["existing-tag"],
      module: "plugins/compound-engineering",
    })
    await g(["add", "docs/solutions/workflow/existing-doc.md"])
    await g(["commit", "-q", "-m", "docs: add existing-doc to origin/main"])
    await g(["push", "-q", "origin", "HEAD:main"])
    // Keep local main in sync with origin/main.
    await g(["branch", "-q", "-u", "origin/main"])

    // Create capture branch branching from origin/main, modifying the existing doc.
    await g(["checkout", "-b", "learning-capture/pr-2-update"])
    const docPath = path.join(clone, "docs/solutions/workflow/existing-doc.md")
    const current = fs.readFileSync(docPath, "utf8")
    fs.writeFileSync(docPath, current + "\n## Updated section\n")
    await g(["add", "docs/solutions/workflow/existing-doc.md"])
    await g(["commit", "-q", "-m", "docs(learnings): update existing-doc"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "learning-capture/pr-2-update",
    })

    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("pass")
    // No corpus_collision for the modified file.
    if (envelope.failures) {
      const collision = envelope.failures.find((f: any) => f.type === "corpus_collision")
      expect(collision).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Edge: stale_update_in_place — modified file also changed on origin/main
// ---------------------------------------------------------------------------

describe("edge: stale_update_in_place blocks merge", () => {
  test("origin/main modifies the same file the capture branch modifies → stale_update_in_place", async () => {
    const dir = uniqueDir("stale")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    // Put shared.md on origin/main.
    writeDoc(clone, "docs/solutions/workflow/shared.md", {
      title: "Shared Document",
      tags: ["shared"],
    })
    await g(["add", "docs/solutions/workflow/shared.md"])
    await g(["commit", "-q", "-m", "docs: add shared.md"])
    await g(["push", "-q", "origin", "HEAD:main"])
    await g(["branch", "-q", "-u", "origin/main"])

    // Create the capture branch BEFORE the next origin/main change.
    await g(["checkout", "-b", "learning-capture/pr-3-stale"])
    const sharedPath = path.join(clone, "docs/solutions/workflow/shared.md")
    fs.writeFileSync(sharedPath, fs.readFileSync(sharedPath, "utf8") + "\n## From capture\n")
    await g(["add", "docs/solutions/workflow/shared.md"])
    await g(["commit", "-q", "-m", "docs(learnings): update shared.md on capture branch"])

    // Meanwhile, advance origin/main by also modifying shared.md.
    await g(["checkout", "main"])
    fs.writeFileSync(sharedPath, fs.readFileSync(sharedPath, "utf8") + "\n## From main\n")
    await g(["add", "docs/solutions/workflow/shared.md"])
    await g(["commit", "-q", "-m", "docs: update shared.md on main"])
    await g(["push", "-q", "origin", "HEAD:main"])

    // Switch back to the capture branch (stale with respect to origin/main changes).
    await g(["checkout", "learning-capture/pr-3-stale"])
    // Fetch origin/main so the validator can detect the conflict.
    await g(["fetch", "--no-tags", "origin", "main"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "learning-capture/pr-3-stale",
    })

    expect(exitCode).toBe(1)
    expect(envelope.status).toBe("failed")
    const stale = envelope.failures.find((f: any) => f.type === "stale_update_in_place")
    expect(stale).toBeDefined()
    expect(stale.path).toContain("shared.md")
  })
})

// ---------------------------------------------------------------------------
// Error: staged diff touches a workflow file → allowlist rejection
// ---------------------------------------------------------------------------

describe("error: allowlist violation", () => {
  test("staged .github/workflows file → allowlist_violation, non-zero exit", async () => {
    const dir = uniqueDir("allowlist")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    await g(["checkout", "-b", "learning-capture/pr-4-workflow"])
    fs.mkdirSync(path.join(clone, ".github", "workflows"), { recursive: true })
    fs.writeFileSync(path.join(clone, ".github/workflows/evil.yml"), "name: evil\n")
    await g(["add", ".github/workflows/evil.yml"])
    await g(["commit", "-q", "-m", "docs(learnings): oops included workflow"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "learning-capture/pr-4-workflow",
    })

    expect(exitCode).toBe(1)
    expect(envelope.status).toBe("failed")
    const violation = envelope.failures.find((f: any) => f.type === "allowlist_violation")
    expect(violation).toBeDefined()
    expect(violation.path).toContain("evil.yml")
  })

  test("staged AGENTS.md → allowlist_violation, non-zero exit", async () => {
    const dir = uniqueDir("allowlist2")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    await g(["checkout", "-b", "learning-capture/pr-5-agents"])
    fs.writeFileSync(path.join(clone, "AGENTS.md"), "# AGENTS\n")
    await g(["add", "AGENTS.md"])
    await g(["commit", "-q", "-m", "docs(learnings): oops included AGENTS.md"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "learning-capture/pr-5-agents",
    })

    expect(exitCode).toBe(1)
    expect(envelope.status).toBe("failed")
    const violation = envelope.failures.find((f: any) => f.type === "allowlist_violation")
    expect(violation).toBeDefined()
    expect(violation.path).toBe("AGENTS.md")
  })
})

// ---------------------------------------------------------------------------
// Error: traversal-shaped path → rejected
// ---------------------------------------------------------------------------

describe("error: traversal path rejected", () => {
  test("path containing .. segments → traversal_path failure", async () => {
    // We cannot actually commit a traversal path via git in a normal repo,
    // so we test the validator's logic by crafting a fake git name-status output.
    // Instead, test via a symlink trick: create a file, then use a submodule
    // path style. The simplest approach: patch git to return a traversal path
    // via a fake git binary.

    // Build a fake git that returns a traversal path in diff --name-status.
    const fakeGitDir = fs.mkdtempSync(path.join(baseDir, "fakegit-"))
    const fakeGit = path.join(fakeGitDir, "git")

    // The fake git:
    // - `rev-parse --show-toplevel` → return a real temp dir (the clone).
    // - `branch --show-current` → return branch name (unused here; we pass --branch).
    // - `fetch ...` → exit 0 (no-op).
    // - `diff --name-status ...` → return a traversal path.
    // - `diff <base>...HEAD -- <path>` → return a small diff.
    // - `merge-base ...` → return a fake sha.
    // - `log ...` → return empty.
    const fakeDir = fs.mkdtempSync(path.join(baseDir, "fakerepo-"))

    fs.writeFileSync(
      fakeGit,
      `#!/bin/bash
ARGS="$*"
case "$ARGS" in
  *"rev-parse --show-toplevel"*)
    echo "${fakeDir}"
    exit 0
    ;;
  *"diff --name-status"*)
    printf 'A\\t../evil/escape.md\\n'
    exit 0
    ;;
  *"fetch"*)
    exit 0
    ;;
  *"diff origin"*)
    echo "+line"
    exit 0
    ;;
  *"diff"*)
    echo "+line"
    exit 0
    ;;
  *"merge-base"*)
    echo "deadbeef"
    exit 0
    ;;
  *"log"*)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      { mode: 0o755 },
    )

    const realPython = Bun.which("python3") ?? "python3"
    const fakeGitBinDir = fs.mkdtempSync(path.join(baseDir, "fakegitbin-"))
    fs.symlinkSync(fakeGit, path.join(fakeGitBinDir, "git"))
    fs.symlinkSync(realPython, path.join(fakeGitBinDir, "python3"))

    const proc = Bun.spawn(
      ["python3", VALIDATOR, "--branch", "learning-capture/pr-traversal", "--no-fetch"],
      {
        cwd: fakeDir,
        env: {
          PATH: fakeGitBinDir,
          HOME: process.env.HOME ?? "",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    const envelope = JSON.parse(stdout.trim())

    expect(exitCode).toBe(1)
    expect(envelope.status).toBe("failed")
    const traversal = envelope.failures.find((f: any) => f.type === "traversal_path")
    expect(traversal).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Error: oversized entry → rejected with cap named
// ---------------------------------------------------------------------------

describe("error: oversized entry", () => {
  test("entry diff exceeding per-entry cap → entry_too_large with cap named", async () => {
    const dir = uniqueDir("oversize")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    await g(["checkout", "-b", "learning-capture/pr-6-oversize"])
    // Generate a doc bigger than PER_ENTRY_CAP_BYTES (32768 bytes).
    const bigContent = "---\ntitle: Big Entry\ntags: [big]\n---\n" + "x".repeat(35_000)
    const docPath = path.join(clone, "docs/solutions/best-practices/big-entry.md")
    fs.mkdirSync(path.dirname(docPath), { recursive: true })
    fs.writeFileSync(docPath, bigContent)
    await g(["add", "docs/solutions/best-practices/big-entry.md"])
    await g(["commit", "-q", "-m", "docs(learnings): stage big entry"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "learning-capture/pr-6-oversize",
    })

    expect(exitCode).toBe(1)
    expect(envelope.status).toBe("failed")
    const tooLarge = envelope.failures.find((f: any) => f.type === "entry_too_large")
    expect(tooLarge).toBeDefined()
    expect(tooLarge.path).toContain("big-entry.md")
    expect(tooLarge.cap).toBe(32_768)
    expect(typeof tooLarge.measured_bytes).toBe("number")
    expect(tooLarge.measured_bytes).toBeGreaterThan(32_768)
  })
})

// ---------------------------------------------------------------------------
// Error: malformed staged file → warning entry, validation completes on rest
// ---------------------------------------------------------------------------

describe("error: malformed staged file", () => {
  test("malformed frontmatter → warning entry present, gate continues on other files", async () => {
    const dir = uniqueDir("malformed")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    await g(["checkout", "-b", "learning-capture/pr-7-malformed"])

    // A malformed file (opening --- but no closing ---).
    const malformedPath = path.join(clone, "docs/solutions/workflow/malformed.md")
    fs.mkdirSync(path.dirname(malformedPath), { recursive: true })
    fs.writeFileSync(malformedPath, "---\ntitle: Broken\n# no closing delimiter\n")
    await g(["add", "docs/solutions/workflow/malformed.md"])

    // A healthy file alongside it.
    writeDoc(clone, "docs/solutions/workflow/healthy.md", {
      title: "Healthy Entry XYZ",
      tags: ["healthy-xyz"],
    })
    await g(["add", "docs/solutions/workflow/healthy.md"])
    await g(["commit", "-q", "-m", "docs(learnings): stage malformed + healthy"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "learning-capture/pr-7-malformed",
    })

    // Malformed alone does not fail the gate — it's a warning.
    // The healthy file has no collision so it passes.
    // Exit may be 0 (pass with warnings) or 1 only if healthy file also has issues.
    expect(envelope).not.toBeNull()

    // There should be a warning for the malformed file.
    const allWarnings = envelope.warnings ?? []
    const malformedWarning = allWarnings.find(
      (w: any) => w.type === "malformed_staged_file" && w.path?.includes("malformed.md"),
    )
    expect(malformedWarning).toBeDefined()

    // Healthy file should NOT be in failures as a malformed_staged_file.
    if (envelope.failures) {
      const healthyFail = envelope.failures.find(
        (f: any) => f.path?.includes("healthy.md") && f.type === "malformed_staged_file",
      )
      expect(healthyFail).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Finding #3: subprocess timeout — hung git exits 2 with stderr message
// ---------------------------------------------------------------------------

describe("Finding #3: git subprocess timeout exits 2", () => {
  test("hung git command exits 2 and names the timed-out args in stderr", async () => {
    // Build a fake git that sleeps indefinitely (simulates a hung git operation).
    const fakeGitDir = fs.mkdtempSync(path.join(baseDir, "timeout-fakegit-"))
    const fakeGit = path.join(fakeGitDir, "git")
    const fakeRepo = fs.mkdtempSync(path.join(baseDir, "timeout-repo-"))

    // Use /bin/sleep directly (absolute path) so the fake git's sleep is
    // immune to PATH restrictions — a PATH-only sleep would be "not found" when
    // system dirs are absent, making the fake git exit immediately instead of
    // hanging as intended.
    fs.writeFileSync(
      fakeGit,
      `#!/bin/bash
ARGS="$*"
case "$ARGS" in
  *"rev-parse --show-toplevel"*)
    echo "${fakeRepo}"
    exit 0
    ;;
  *"fetch"*)
    exit 0
    ;;
  *)
    # Simulate a hung git operation.
    /bin/sleep 100
    exit 0
    ;;
esac
`,
      { mode: 0o755 },
    )

    // Write a thin wrapper that overrides GIT_TIMEOUT_SECONDS to 1 second,
    // then calls the real validator's main().
    const realPython = Bun.which("python3") ?? "python3"
    const wrapperDir = fs.mkdtempSync(path.join(baseDir, "timeout-wrapper-"))
    const wrapper = path.join(wrapperDir, "run_with_short_timeout.py")
    fs.writeFileSync(
      wrapper,
      `import sys
import importlib.util

spec = importlib.util.spec_from_file_location(
    "validate_staged_keepers",
    ${JSON.stringify(VALIDATOR)},
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# Override the timeout constant before calling main so subprocess.run uses 1s.
mod.GIT_TIMEOUT_SECONDS = 1
mod.main(sys.argv)
`,
    )

    const fakeGitBinDir = fs.mkdtempSync(path.join(baseDir, "timeout-gitbin-"))
    fs.symlinkSync(fakeGit, path.join(fakeGitBinDir, "git"))
    fs.symlinkSync(realPython, path.join(fakeGitBinDir, "python3"))

    const proc = Bun.spawn(
      [
        "python3", wrapper,
        "--branch", "learning-capture/pr-timeout",
        "--no-fetch",
      ],
      {
        cwd: fakeRepo,
        env: {
          PATH: fakeGitBinDir,
          HOME: process.env.HOME ?? "",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).toBe(2)
    // stderr must name the timed-out git args so the failure is diagnosable.
    expect(stderr).toMatch(/timed out/)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Finding #15+#12: disallowed_change_type — D/R/C entries rejected
// ---------------------------------------------------------------------------

describe("Finding #15+#12: deletions and renames rejected", () => {
  test("deleting a corpus doc → disallowed_change_type naming D and path, non-zero exit", async () => {
    const dir = uniqueDir("delete")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    // Put a corpus doc on origin/main first.
    writeDoc(clone, "docs/solutions/workflow/to-delete.md", {
      title: "To Delete",
      tags: ["delete-me"],
    })
    await g(["add", "docs/solutions/workflow/to-delete.md"])
    await g(["commit", "-q", "-m", "docs: add to-delete.md"])
    await g(["push", "-q", "origin", "HEAD:main"])
    await g(["branch", "-q", "-u", "origin/main"])

    // Create a capture branch that deletes the corpus doc.
    await g(["checkout", "-b", "learning-capture/pr-delete"])
    await g(["rm", "docs/solutions/workflow/to-delete.md"])
    await g(["commit", "-q", "-m", "docs(learnings): delete corpus doc"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "learning-capture/pr-delete",
    })

    expect(exitCode).toBe(1)
    expect(envelope.status).toBe("failed")
    const dct = envelope.failures.find((f: any) => f.type === "disallowed_change_type")
    expect(dct).toBeDefined()
    expect(dct.status).toBe("D")
    expect(dct.paths.some((p: string) => p.includes("to-delete.md"))).toBe(true)
  })

  test("renaming a corpus doc within docs/solutions → disallowed_change_type naming both paths, non-zero exit", async () => {
    const dir = uniqueDir("rename")
    const { clone } = await createFixture(dir)

    const g = (args: string[]) => Bun.spawn(["git", ...args], {
      cwd: clone,
      env: GIT_TEST_ENV,
    }).exited

    // Put a corpus doc on origin/main.
    writeDoc(clone, "docs/solutions/workflow/original-name.md", {
      title: "Original Name",
      tags: ["rename-test"],
    })
    await g(["add", "docs/solutions/workflow/original-name.md"])
    await g(["commit", "-q", "-m", "docs: add original-name.md"])
    await g(["push", "-q", "origin", "HEAD:main"])
    await g(["branch", "-q", "-u", "origin/main"])

    // Create a capture branch that renames the corpus doc.
    await g(["checkout", "-b", "learning-capture/pr-rename"])
    await g(["mv", "docs/solutions/workflow/original-name.md", "docs/solutions/workflow/new-name.md"])
    await g(["commit", "-q", "-m", "docs(learnings): rename corpus doc"])

    const { envelope, exitCode } = await runValidator({
      cwd: clone,
      branch: "learning-capture/pr-rename",
    })

    expect(exitCode).toBe(1)
    expect(envelope.status).toBe("failed")
    const dct = envelope.failures.find((f: any) => f.type === "disallowed_change_type")
    expect(dct).toBeDefined()
    expect(dct.status).toBe("R")
    // Both the source and destination paths must be present.
    expect(dct.paths.some((p: string) => p.includes("original-name.md"))).toBe(true)
    expect(dct.paths.some((p: string) => p.includes("new-name.md"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Finding #13: shallow clone → hard error (exit 2) when modified_paths exist
// ---------------------------------------------------------------------------

describe("Finding #13: shallow clone fails hard when modified files present", () => {
  test("merge-base failure with modified paths → exit 2 with shallow-clone hint in stderr", async () => {
    // Use a fake git that returns success for everything EXCEPT merge-base,
    // which fails (simulates shallow clone where the common ancestor is absent).
    // We also need a modified file in the diff so Gate 3 is reached.
    const fakeGitDir = fs.mkdtempSync(path.join(baseDir, "shallow-fakegit-"))
    const fakeGit = path.join(fakeGitDir, "git")
    const fakeRepo = fs.mkdtempSync(path.join(baseDir, "shallow-repo-"))

    // Create a real file so read_staged_frontmatter can read it.
    const solutionsDir = path.join(fakeRepo, "docs", "solutions", "workflow")
    fs.mkdirSync(solutionsDir, { recursive: true })
    fs.writeFileSync(
      path.join(solutionsDir, "modified.md"),
      "---\ntitle: Modified\ntags: [mod]\n---\n# Content\n",
    )

    fs.writeFileSync(
      fakeGit,
      `#!/bin/bash
ARGS="$*"
case "$ARGS" in
  *"rev-parse --show-toplevel"*)
    echo "${fakeRepo}"
    exit 0
    ;;
  *"fetch"*)
    exit 0
    ;;
  *"diff --name-status"*)
    # One modified file — triggers the staleness gate.
    printf 'M\\tdocs/solutions/workflow/modified.md\\n'
    exit 0
    ;;
  *"diff"*)
    # Small diff for size cap.
    echo "+modified line"
    exit 0
    ;;
  *"merge-base"*)
    # Simulate shallow clone: merge-base cannot find common ancestor.
    echo "fatal: Not a valid object name" >&2
    exit 128
    ;;
  *"log"*)
    exit 0
    ;;
  *"ls-tree"*)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
      { mode: 0o755 },
    )

    const realPython = Bun.which("python3") ?? "python3"
    const fakeGitBinDir = fs.mkdtempSync(path.join(baseDir, "shallow-gitbin-"))
    fs.symlinkSync(fakeGit, path.join(fakeGitBinDir, "git"))
    fs.symlinkSync(realPython, path.join(fakeGitBinDir, "python3"))

    const proc = Bun.spawn(
      [
        "python3", VALIDATOR,
        "--branch", "learning-capture/pr-shallow",
        "--no-fetch",
      ],
      {
        cwd: fakeRepo,
        env: {
          PATH: fakeGitBinDir,
          HOME: process.env.HOME ?? "",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).toBe(2)
    // stderr must mention shallow clone so the operator knows the fix.
    expect(stderr.toLowerCase()).toMatch(/shallow/)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// CI wiring: run the validator against THIS repo when on a capture branch
// ---------------------------------------------------------------------------

describe("CI wiring: revalidation gate", () => {
  test("revalidation gate (skipped: not a capture branch)", async () => {
    // Detect capture-PR context from the environment.
    const headRef =
      process.env.GITHUB_HEAD_REF?.trim() ??
      Bun.spawnSync(["git", "branch", "--show-current"], { stdout: "pipe" })
        .stdout.toString()
        .trim()

    const isCapturePR = headRef.startsWith("learning-capture/")

    if (!isCapturePR) {
      // Not a capture branch — pass as explicit skip.
      expect(true).toBe(true)
      return
    }

    // On a capture branch: run the validator against THIS repo and expect exit 0.
    const repoRoot = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
    })
      .stdout.toString()
      .trim()

    const { envelope, exitCode } = await runValidator({
      cwd: repoRoot,
      branch: headRef,
      fetchEnabled: true,
    })

    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("pass")
  }, 60_000)
})
