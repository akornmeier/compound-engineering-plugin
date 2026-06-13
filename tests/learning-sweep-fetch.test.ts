import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * Behavioral tests for ce-learning-sweep's fetch-pr-data.py.
 *
 * The script's only external dependency is the `gh` CLI. To exercise every
 * named state without network, each test prepends a fake `gh` shim to PATH.
 * The shim dispatches on the gh subcommand and serves fixture files (or
 * induces a failure) under env-var control:
 *
 *   GH_SHIM_NO_AUTH=1        -> `gh auth status` exits 1 (gh present but unauthed)
 *   GH_SHIM_NOT_FOUND=1      -> `gh pr view --json state` prints the resolve
 *                               error to stderr and exits 1
 *   GH_SHIM_STATE_FILE       -> served for `gh pr view --json state,...`
 *   GH_SHIM_COMMITS_FILE     -> served for `gh pr view --json commits`
 *   GH_SHIM_COMMITS_FAIL=1   -> `gh pr view --json commits` exits 1
 *   GH_SHIM_DIFF_FILE        -> served for `gh pr diff`
 *   GH_SHIM_DIFF_FAIL=1      -> `gh pr diff` exits 1
 *   GH_SHIM_THREADS_FILE     -> served for `gh api graphql` (the slurped pages)
 *   GH_SHIM_THREADS_FAIL=1   -> `gh api graphql` exits 1
 *
 * Absence of gh is simulated by running with a PATH whose only entry holds
 * python3/git but no `gh` at all, so the script's subprocess call raises
 * FileNotFoundError and the script reports `no_forge`.
 */

const SCRIPT = path.join(
  __dirname,
  "../plugins/compound-engineering/skills/ce-learning-sweep/scripts/fetch-pr-data.py",
)
const FIXTURES = path.join(__dirname, "fixtures/learning-sweep")

let shimDir: string
let realDir: string // a PATH dir that also exposes git + python3 alongside the shim
let noGhDir: string // a PATH dir with git + python3 but NO gh shim

beforeAll(() => {
  // The shim lives in its own dir. We symlink the real git/python3 next to it
  // so the script can still resolve origin and run, while `gh` is our fake.
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-fetch-shim-"))

  const ghShim = `#!/bin/bash
# Fake gh for ce-learning-sweep tests. Dispatch on subcommand.
# Absolute shebang (not /usr/bin/env bash): tests run the script under a
# restricted PATH that holds only the shim + symlinked git/python3, so
# \`env\` could not find bash on PATH.
#
# Fixture files are slurped with bash's built-in \`$(<file)\` form, NOT \`cat\`:
# the restricted PATH has no coreutils, so an external \`cat\` would fail with
# "command not found". \`printf\` is a bash builtin and is safe.
emit_file() { printf '%s' "$(<"$1")"; }

sub="$1"
shift || true
args="$*"

if [ "$sub" = "auth" ]; then
  if [ "$GH_SHIM_NO_AUTH" = "1" ]; then
    echo "not logged in" >&2
    exit 1
  fi
  echo "Logged in"
  exit 0
fi

if [ "$sub" = "pr" ]; then
  pr_sub="$1"
  if [ "$pr_sub" = "view" ]; then
    case "$args" in
      *commits*)
        if [ "$GH_SHIM_COMMITS_FAIL" = "1" ]; then
          echo "commits fetch boom" >&2
          exit 1
        fi
        emit_file "$GH_SHIM_COMMITS_FILE"
        exit 0
        ;;
      *state*)
        if [ "$GH_SHIM_NOT_FOUND" = "1" ]; then
          echo "GraphQL: Could not resolve to a PullRequest with the number." >&2
          exit 1
        fi
        emit_file "$GH_SHIM_STATE_FILE"
        exit 0
        ;;
    esac
  fi
  if [ "$pr_sub" = "diff" ]; then
    if [ "$GH_SHIM_DIFF_FAIL" = "1" ]; then
      echo "diff fetch boom" >&2
      exit 1
    fi
    emit_file "$GH_SHIM_DIFF_FILE"
    exit 0
  fi
  if [ "$pr_sub" = "list" ]; then
    if [ "$GH_SHIM_CAPTURE_PR_FAIL" = "1" ]; then
      echo "pr list boom" >&2
      exit 1
    fi
    if [ -n "$GH_SHIM_CAPTURE_PR_FILE" ]; then
      emit_file "$GH_SHIM_CAPTURE_PR_FILE"
    else
      printf '[]'
    fi
    exit 0
  fi
fi

if [ "$sub" = "api" ]; then
  if [ "$GH_SHIM_THREADS_FAIL" = "1" ]; then
    echo "graphql boom" >&2
    exit 1
  fi
  emit_file "$GH_SHIM_THREADS_FILE"
  exit 0
fi

echo "fake gh: unhandled invocation: $sub $args" >&2
exit 99
`
  fs.writeFileSync(path.join(shimDir, "gh"), ghShim, { mode: 0o755 })

  // Resolve the real git/python3 so the shimmed PATH can still run them.
  const realGit = Bun.which("git")
  const realPython = Bun.which("python3")
  if (!realGit || !realPython) {
    throw new Error("test setup: git and python3 must be on PATH")
  }

  realDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-fetch-bin-"))
  noGhDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-fetch-nogh-"))
  for (const dir of [realDir, noGhDir]) {
    fs.symlinkSync(realGit, path.join(dir, "git"))
    fs.symlinkSync(realPython, path.join(dir, "python3"))
  }
  // realDir also carries the gh shim; noGhDir deliberately does not.
  fs.symlinkSync(path.join(shimDir, "gh"), path.join(realDir, "gh"))
})

afterAll(() => {
  for (const dir of [shimDir, realDir, noGhDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

interface RunOpts {
  ref?: string
  env?: Record<string, string>
  /** When true, run with a PATH that lacks the gh shim entirely. */
  noGh?: boolean
  /** Override the working dir so a test controls origin resolution. */
  cwd?: string
}

async function run(opts: RunOpts = {}): Promise<{
  envelope: any
  stdout: string
  stderr: string
  exitCode: number
}> {
  const ref = opts.ref ?? "42"
  const binDir = opts.noGh ? noGhDir : realDir
  const proc = Bun.spawn(["python3", SCRIPT, ref], {
    cwd: opts.cwd ?? process.cwd(),
    env: {
      // A minimal PATH so the script resolves only our shim (or no gh at all).
      PATH: binDir,
      HOME: process.env.HOME ?? "",
      // Default fixture wiring; individual tests override via opts.env.
      GH_SHIM_STATE_FILE: path.join(FIXTURES, "pr-view-state.json"),
      GH_SHIM_COMMITS_FILE: path.join(FIXTURES, "pr-view-commits.json"),
      GH_SHIM_DIFF_FILE: path.join(FIXTURES, "pr.diff"),
      GH_SHIM_THREADS_FILE: path.join(FIXTURES, "threads-multipage.json"),
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
    envelope = JSON.parse(trimmed)
  }
  return { envelope, stdout, stderr, exitCode }
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------
describe("fetch-pr-data: happy paths", () => {
  test("multi-page thread fixtures merge into one complete list; isResolved preserved", async () => {
    const { envelope, exitCode } = await run()
    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("ok")
    // Two pages, one thread each -> one merged list of two threads.
    expect(envelope.threads_raw).toHaveLength(2)
    const ids = envelope.threads_raw.map((t: any) => t.id)
    expect(ids).toContain("THREAD_PAGE1_RESOLVED")
    expect(ids).toContain("THREAD_PAGE2_UNRESOLVED")
    // Resolved thread present with isResolved preserved (not filtered out).
    const resolved = envelope.threads_raw.find(
      (t: any) => t.id === "THREAD_PAGE1_RESOLVED",
    )
    expect(resolved.isResolved).toBe(true)
    const unresolved = envelope.threads_raw.find(
      (t: any) => t.id === "THREAD_PAGE2_UNRESOLVED",
    )
    expect(unresolved.isResolved).toBe(false)
  })

  test("diff and commit messages land in the envelope under raw-provenance keys", async () => {
    const { envelope } = await run()
    expect(envelope.status).toBe("ok")
    // R6: mined content nests under *_raw keys.
    expect(typeof envelope.diff_raw).toBe("string")
    expect(envelope.diff_raw).toContain("src/widget.ts")
    expect(Array.isArray(envelope.commits_raw)).toBe(true)
    expect(envelope.commits_raw).toHaveLength(2)
    expect(envelope.commits_raw[0].headline).toBe("feat(widget): add retry backoff")
    expect(envelope.commits_raw[0].body).toContain("exponential backoff")
    expect(envelope.commits_raw[0].oid).toBe(
      "aaaa111122223333444455556666777788889999",
    )
  })

  test("zero review threads -> empty list, NO degraded flag (normal state)", async () => {
    const { envelope } = await run({
      env: { GH_SHIM_THREADS_FILE: path.join(FIXTURES, "threads-empty.json") },
    })
    expect(envelope.status).toBe("ok")
    expect(envelope.threads_raw).toEqual([])
    expect(envelope.flags.degraded_inputs).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Degradation and large-input policy
// ---------------------------------------------------------------------------
describe("fetch-pr-data: degradation and caps", () => {
  test("thread fetch fails while gh works -> degraded flag set, diff+commits still present", async () => {
    const { envelope } = await run({ env: { GH_SHIM_THREADS_FAIL: "1" } })
    expect(envelope.status).toBe("ok")
    expect(envelope.flags.degraded_inputs).toContain("review_threads")
    expect(envelope.threads_raw).toEqual([])
    expect(envelope.diff_raw).toContain("src/widget.ts")
    expect(envelope.commits_raw).toHaveLength(2)
  })

  test("lockfile and generated-file hunks excluded; exclusion noted in envelope", async () => {
    const { envelope } = await run()
    expect(envelope.status).toBe("ok")
    expect(envelope.diff_raw).toContain("src/widget.ts")
    expect(envelope.diff_raw).not.toContain("bun.lock")
    expect(envelope.diff_raw).not.toContain("dist/bundle.js")
    expect(envelope.diff_raw).not.toContain("assets/app.min.js")
    expect(envelope.flags.excluded_paths).toContain("bun.lock")
    expect(envelope.flags.excluded_paths).toContain("dist/bundle.js")
    expect(envelope.flags.excluded_paths).toContain("assets/app.min.js")
  })

  test("binary diff block (no +++/--- lines) is excluded by diff --git header fallback", async () => {
    // git/gh emits binary diffs without +++/--- lines; the filter must use the
    // diff --git header to extract the path so exclusion still applies.
    const binaryDiff =
      "diff --git a/src/widget.ts b/src/widget.ts\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/src/widget.ts\n" +
      "+++ b/src/widget.ts\n" +
      "@@ -1,1 +1,1 @@\n" +
      "+x\n" +
      "diff --git a/bun.lockb b/bun.lockb\n" +
      "index 3333333..4444444 100644\n" +
      "Binary files a/bun.lockb and b/bun.lockb differ\n"
    const diffFile = path.join(os.tmpdir(), `ls-bindiff-${Date.now()}.diff`)
    fs.writeFileSync(diffFile, binaryDiff)
    try {
      const { envelope } = await run({ env: { GH_SHIM_DIFF_FILE: diffFile } })
      expect(envelope.status).toBe("ok")
      expect(envelope.diff_raw).toContain("src/widget.ts")
      expect(envelope.diff_raw).not.toContain("bun.lockb")
      expect(envelope.flags.excluded_paths).toContain("bun.lockb")
    } finally {
      fs.rmSync(diffFile, { force: true })
    }
  })

  test("generated-dir exclusion matches path segments, not substrings", async () => {
    // src/redist and prebuild contain "dist"/"build" as substrings but are not
    // generated dirs; only a real dist/build *segment* should be excluded.
    const mkBlock = (p: string) =>
      `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n+x\n`
    const diff =
      mkBlock("src/redist/file.js") +
      mkBlock("prebuild/file.js") +
      mkBlock("dist/file.js") +
      mkBlock("pkg/dist/file.js")
    const segDiff = path.join(os.tmpdir(), `ls-segdiff-${Date.now()}.diff`)
    fs.writeFileSync(segDiff, diff)
    try {
      const { envelope } = await run({ env: { GH_SHIM_DIFF_FILE: segDiff } })
      expect(envelope.status).toBe("ok")
      // Kept: "dist"/"build" only appear as substrings of a path segment.
      expect(envelope.diff_raw).toContain("src/redist/file.js")
      expect(envelope.diff_raw).toContain("prebuild/file.js")
      expect(envelope.flags.excluded_paths).not.toContain("src/redist/file.js")
      expect(envelope.flags.excluded_paths).not.toContain("prebuild/file.js")
      // Excluded: a real dist segment at any depth.
      expect(envelope.diff_raw).not.toContain("a/dist/file.js")
      expect(envelope.diff_raw).not.toContain("pkg/dist/file.js")
      expect(envelope.flags.excluded_paths).toContain("dist/file.js")
      expect(envelope.flags.excluded_paths).toContain("pkg/dist/file.js")
    } finally {
      fs.rmSync(segDiff, { force: true })
    }
  })

  test("oversized diff -> truncated with diff truncation flag set", async () => {
    // Build a diff well over MAX_DIFF_BYTES (200_000) for one kept file.
    const big = path.join(os.tmpdir(), `ls-bigdiff-${Date.now()}.diff`)
    const header = "diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1,1 +1,100000 @@\n"
    const body = Array.from({ length: 100_000 }, (_, i) => `+line ${i}\n`).join("")
    fs.writeFileSync(big, header + body)
    try {
      const { envelope } = await run({ env: { GH_SHIM_DIFF_FILE: big } })
      expect(envelope.status).toBe("ok")
      expect(envelope.flags.truncations.diff).toBe(true)
      expect(Buffer.byteLength(envelope.diff_raw, "utf8")).toBeLessThanOrEqual(
        200_000,
      )
    } finally {
      fs.rmSync(big, { force: true })
    }
  })

  test("oversized thread volume -> truncated with threads truncation flag set", async () => {
    // One page carrying more than MAX_THREADS (200) thread nodes.
    const nodes = Array.from({ length: 250 }, (_, i) => ({
      id: `T${i}`,
      isResolved: i % 2 === 0,
      isOutdated: false,
      path: "src/x.ts",
      line: i,
      comments: { nodes: [{ author: { login: "r" }, body: `c${i}`, url: `u${i}` }] },
    }))
    const page = [
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    ]
    const bigThreads = path.join(os.tmpdir(), `ls-bigthreads-${Date.now()}.json`)
    fs.writeFileSync(bigThreads, JSON.stringify(page))
    try {
      const { envelope } = await run({ env: { GH_SHIM_THREADS_FILE: bigThreads } })
      expect(envelope.status).toBe("ok")
      expect(envelope.flags.truncations.threads).toBe(true)
      expect(envelope.threads_raw.length).toBe(200)
    } finally {
      fs.rmSync(bigThreads, { force: true })
    }
  })

  test("thread with comments totalCount over the cap -> thread_comments flag set", async () => {
    // comments(first: 20) silently drops the rest; totalCount discloses it.
    const page = [
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "T_DEEP",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/x.ts",
                    line: 1,
                    comments: {
                      totalCount: 25,
                      nodes: [{ author: { login: "r" }, body: "c0", url: "u0" }],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    ]
    const deepThreads = path.join(os.tmpdir(), `ls-deepthreads-${Date.now()}.json`)
    fs.writeFileSync(deepThreads, JSON.stringify(page))
    try {
      const { envelope } = await run({
        env: { GH_SHIM_THREADS_FILE: deepThreads },
      })
      expect(envelope.status).toBe("ok")
      expect(envelope.flags.truncations.thread_comments).toBe(true)
    } finally {
      fs.rmSync(deepThreads, { force: true })
    }
  })

  test("threads within the per-thread comment cap -> thread_comments flag false", async () => {
    const { envelope } = await run()
    expect(envelope.status).toBe("ok")
    expect(envelope.flags.truncations.thread_comments).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Error / non-ok states
// ---------------------------------------------------------------------------
describe("fetch-pr-data: named non-ok states", () => {
  test("not-found PR -> not_found state, exit 0", async () => {
    const { envelope, exitCode } = await run({ env: { GH_SHIM_NOT_FOUND: "1" } })
    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("not_found")
  })

  // Draft is asserted distinct from open: both have state OPEN, only isDraft differs.
  test.each([
    ["open", { state: "OPEN", isDraft: false }],
    ["draft", { state: "OPEN", isDraft: true }],
    ["closed_unmerged", { state: "CLOSED", isDraft: false }],
  ])("non-merged PR -> not_merged with detail=%s", async (detail, stateFields) => {
    const stateFile = path.join(os.tmpdir(), `ls-${detail}-${Date.now()}.json`)
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ ...stateFields, mergedAt: null, number: 42, title: `${detail} one` }),
    )
    try {
      const { envelope } = await run({ env: { GH_SHIM_STATE_FILE: stateFile } })
      expect(envelope.status).toBe("not_merged")
      expect(envelope.detail).toBe(detail)
    } finally {
      fs.rmSync(stateFile, { force: true })
    }
  })

  test("gh binary absent -> no_forge", async () => {
    const { envelope, exitCode } = await run({ noGh: true })
    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("no_forge")
  })

  test("gh present but not authenticated -> no_forge", async () => {
    const { envelope } = await run({ env: { GH_SHIM_NO_AUTH: "1" } })
    expect(envelope.status).toBe("no_forge")
  })

  test("cross-repo reference -> repo_mismatch", async () => {
    const { envelope } = await run({ ref: "other-owner/other-repo#42" })
    expect(envelope.status).toBe("repo_mismatch")
    expect(envelope.detail).toContain("other-owner/other-repo")
  })

  test("explicit-repo ref with an unresolvable origin -> no_forge", async () => {
    // A git repo with no origin remote: the ref names a repo but there is no
    // origin to validate against, so this is no_forge, not repo_mismatch.
    const noOrigin = fs.mkdtempSync(path.join(os.tmpdir(), "ls-no-origin-"))
    await Bun.spawn(["git", "init", "-q", noOrigin]).exited
    try {
      const { envelope } = await run({
        ref: "some-owner/some-repo#42",
        cwd: noOrigin,
      })
      expect(envelope.status).toBe("no_forge")
      expect(envelope.detail).toContain("origin")
    } finally {
      fs.rmSync(noOrigin, { recursive: true, force: true })
    }
  })

  test("URL ref whose host differs from origin -> repo_mismatch", async () => {
    // owner/repo match origin but the forge host does not; the slug alone is
    // ambiguous across forges, so a host mismatch must be rejected.
    const slug = (
      await new Response(
        Bun.spawn(["git", "remote", "get-url", "origin"], {
          stdout: "pipe",
        }).stdout,
      ).text()
    )
      .trim()
      .replace(/^(git@[^:]+:|ssh:\/\/git@[^/]+\/|https?:\/\/[^/]+\/)/, "")
      .replace(/\.git$/, "")
    const { envelope } = await run({
      ref: `https://evil.example/${slug}/pull/42`,
    })
    expect(envelope.status).toBe("repo_mismatch")
    expect(envelope.detail).toContain("evil.example")
  })

  test("diff fetch fails on a valid merged PR -> fetch_failed", async () => {
    const { envelope } = await run({ env: { GH_SHIM_DIFF_FAIL: "1" } })
    expect(envelope.status).toBe("fetch_failed")
  })

  test("commits fetch fails on a valid merged PR -> fetch_failed", async () => {
    const { envelope } = await run({ env: { GH_SHIM_COMMITS_FAIL: "1" } })
    expect(envelope.status).toBe("fetch_failed")
  })
})

// ---------------------------------------------------------------------------
// Reference-form parsing
// ---------------------------------------------------------------------------
describe("fetch-pr-data: reference forms", () => {
  test.each([
    ["42", "bare number"],
    ["#42", "hash-prefixed"],
  ])("accepts %s (%s)", async (ref) => {
    const { envelope } = await run({ ref })
    expect(envelope.status).toBe("ok")
    expect(envelope.pr).toBe(42)
  })

  test("accepts a same-repo full URL", async () => {
    // The shim does not validate the repo, so a URL whose owner/repo match the
    // working dir's origin must mine cleanly. Derive origin to build the URL.
    const slug = (
      await new Response(
        Bun.spawn(["git", "remote", "get-url", "origin"], {
          stdout: "pipe",
        }).stdout,
      ).text()
    )
      .trim()
      .replace(/^(git@[^:]+:|ssh:\/\/git@[^/]+\/|https?:\/\/[^/]+\/)/, "")
      .replace(/\.git$/, "")
    const { envelope } = await run({
      ref: `https://github.com/${slug}/pull/42`,
    })
    expect(envelope.status).toBe("ok")
    expect(envelope.pr).toBe(42)
  })

  test("unrecognized reference -> non-zero exit (internal error, not a state)", async () => {
    const { exitCode, stderr, stdout } = await run({ ref: "not-a-pr" })
    expect(exitCode).not.toBe(0)
    expect(stdout.trim()).toBe("")
    expect(stderr).toContain("unrecognized PR reference")
  })
})

// ---------------------------------------------------------------------------
// Already-swept probe (capture_pr field in ok envelope)
// ---------------------------------------------------------------------------
describe("fetch-pr-data: already-swept probe", () => {
  test("capture PR exists (open) → envelope carries capture_pr with number and state", async () => {
    const capturePrFile = path.join(
      os.tmpdir(),
      `ls-capture-pr-open-${Date.now()}.json`,
    )
    fs.writeFileSync(
      capturePrFile,
      JSON.stringify([
        {
          number: 55,
          state: "OPEN",
          url: "https://github.com/owner/repo/pull/55",
          headRefName: "learning-capture/pr-42-20260612-abc1",
        },
      ]),
    )
    try {
      const { envelope } = await run({
        env: { GH_SHIM_CAPTURE_PR_FILE: capturePrFile },
      })
      expect(envelope.status).toBe("ok")
      expect(envelope.capture_pr).toBeDefined()
      expect(envelope.capture_pr.number).toBe(55)
      expect(envelope.capture_pr.state).toBe("OPEN")
      expect(envelope.capture_pr.url).toContain("pull/55")
    } finally {
      fs.rmSync(capturePrFile, { force: true })
    }
  })

  test("closed-unmerged capture PR → probe reports it (durable rejection record)", async () => {
    const capturePrFile = path.join(
      os.tmpdir(),
      `ls-capture-pr-closed-${Date.now()}.json`,
    )
    fs.writeFileSync(
      capturePrFile,
      JSON.stringify([
        {
          number: 60,
          state: "CLOSED",
          url: "https://github.com/owner/repo/pull/60",
          headRefName: "learning-capture/pr-42-20260611-def2",
        },
      ]),
    )
    try {
      const { envelope } = await run({
        env: { GH_SHIM_CAPTURE_PR_FILE: capturePrFile },
      })
      expect(envelope.status).toBe("ok")
      expect(envelope.capture_pr).toBeDefined()
      expect(envelope.capture_pr.number).toBe(60)
      expect(envelope.capture_pr.state).toBe("CLOSED")
    } finally {
      fs.rmSync(capturePrFile, { force: true })
    }
  })

  test("no capture PR found → capture_pr field absent from envelope", async () => {
    // Default shim returns [] for pr list — no capture PR.
    const { envelope } = await run()
    expect(envelope.status).toBe("ok")
    expect(envelope.capture_pr).toBeUndefined()
  })

  test("search hit with non-matching head branch → filtered out, capture_pr absent", async () => {
    // GitHub's --search head: qualifier is a text match, not exact — the probe
    // re-filters on the actual headRefName prefix for THIS source PR.
    const capturePrFile = path.join(
      os.tmpdir(),
      `ls-capture-pr-mismatch-${Date.now()}.json`,
    )
    fs.writeFileSync(
      capturePrFile,
      JSON.stringify([
        {
          number: 70,
          state: "OPEN",
          url: "https://github.com/owner/repo/pull/70",
          headRefName: "learning-capture/pr-420-20260610-zzz9",
        },
      ]),
    )
    try {
      const { envelope } = await run({
        env: { GH_SHIM_CAPTURE_PR_FILE: capturePrFile },
      })
      expect(envelope.status).toBe("ok")
      expect(envelope.capture_pr).toBeUndefined()
    } finally {
      fs.rmSync(capturePrFile, { force: true })
    }
  })

  test("probe failure → sweep envelope still ok, capture_pr absent (non-fatal)", async () => {
    const { envelope, exitCode } = await run({
      env: { GH_SHIM_CAPTURE_PR_FAIL: "1" },
    })
    // Sweep must not fail — probe failure is non-fatal.
    expect(exitCode).toBe(0)
    expect(envelope.status).toBe("ok")
    // capture_pr absent when probe fails.
    expect(envelope.capture_pr).toBeUndefined()
    // Main inputs still present.
    expect(typeof envelope.diff_raw).toBe("string")
    expect(Array.isArray(envelope.commits_raw)).toBe(true)
  })
})
