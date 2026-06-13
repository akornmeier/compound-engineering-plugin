import { readFileSync } from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"

/**
 * The two GraphQL fetch scripts in ce-resolve-pr-feedback must paginate.
 *
 * Issue #798: previous versions used fixed `first: N` page sizes with no
 * cursor loop, so PRs with more than one page of review threads / comments /
 * reviews silently dropped everything past page 1. The skill then reported
 * "0 of 0 resolved" while real findings sat unanswered.
 *
 * `gh api graphql --paginate` follows only one `pageInfo` per response, so
 * `get-pr-comments` must issue a separate paginated query for each top-level
 * connection. `get-thread-for-comment` paginates the single `reviewThreads`
 * connection it queries.
 */

const SCRIPTS_DIR = path.join(
  process.cwd(),
  "plugins/compound-engineering/skills/ce-resolve-pr-feedback/scripts",
)

const PAGE_INFO_SELECTION = /pageInfo\s*\{\s*hasNextPage\s+endCursor\s*\}/

function read(name: string): string {
  return readFileSync(path.join(SCRIPTS_DIR, name), "utf8")
}

describe("ce-resolve-pr-feedback scripts paginate GraphQL connections (issue #798)", () => {
  test("get-pr-comments uses --paginate for every top-level connection", () => {
    const body = read("get-pr-comments")
    const paginateCount = (body.match(/gh api graphql --paginate\b/g) ?? []).length
    expect(
      paginateCount,
      "get-pr-comments must issue three paginated queries (reviewThreads, comments, reviews); `gh api graphql --paginate` only follows the outermost pageInfo per response, so combining them in one query silently drops everything past page 1.",
    ).toBeGreaterThanOrEqual(3)
  })

  test("get-pr-comments paginates every connection it queries", () => {
    const body = read("get-pr-comments")
    for (const conn of ["reviewThreads", "comments", "reviews"]) {
      const re = new RegExp(`${conn}\\(first:\\s*\\d+,\\s*after:\\s*\\$endCursor\\)`)
      expect(
        re.test(body),
        `get-pr-comments must call ${conn}(first: N, after: $endCursor); fixed page sizes truncate on long-lived PRs.`,
      ).toBe(true)
    }
  })

  test("get-pr-comments selects pageInfo { hasNextPage endCursor } in each query", () => {
    const body = read("get-pr-comments")
    const matches = body.match(new RegExp(PAGE_INFO_SELECTION.source, "g")) ?? []
    expect(
      matches.length,
      "Each paginated GraphQL query must select pageInfo { hasNextPage endCursor } so `gh api graphql --paginate` can drive the cursor loop.",
    ).toBeGreaterThanOrEqual(3)
  })

  test("get-thread-for-comment paginates the reviewThreads connection", () => {
    const body = read("get-thread-for-comment")
    expect(
      body,
      "get-thread-for-comment must paginate reviewThreads, otherwise comment lookups fail on PRs with >100 threads.",
    ).toMatch(/gh api graphql --paginate\b/)
    expect(body).toMatch(/reviewThreads\(first:\s*\d+,\s*after:\s*\$endCursor\)/)
    expect(body).toMatch(PAGE_INFO_SELECTION)
  })
})

/**
 * Repo resolution must anchor on the checkout's `origin` remote, not gh's
 * configured default-repo.
 *
 * In a fork checkout, `gh repo view` returns the upstream parent (gh's default
 * base repo), so a branch's PR number gets queried against the wrong repo --
 * the script returns a foreign PR or empty results and the skill reports
 * "0 unresolved" while real threads sit open. Both fetch scripts must derive
 * OWNER/REPO from `git remote get-url origin` before ever falling back to
 * `gh repo view`.
 */
describe("ce-resolve-pr-feedback scripts resolve repo from origin remote, not gh default-repo", () => {
  for (const name of ["get-pr-comments", "get-thread-for-comment"]) {
    test(`${name} prefers the origin remote over gh's default-repo`, () => {
      const body = read(name)

      const originIdx = body.indexOf("git remote get-url origin")
      expect(
        originIdx,
        `${name} must resolve OWNER/REPO from \`git remote get-url origin\` (the branch's push target / where its PR lives).`,
      ).toBeGreaterThan(-1)

      // Match the command invocation, not prose mentions of "gh repo view".
      const ghViewIdx = body.indexOf("gh repo view --json")
      // gh repo view may remain as a last-resort fallback, but only AFTER the
      // origin-remote resolution -- never as the primary source.
      if (ghViewIdx > -1) {
        expect(
          originIdx,
          `${name} must attempt the origin remote before falling back to \`gh repo view\`; gh's default-repo points at the upstream parent in a fork.`,
        ).toBeLessThan(ghViewIdx)
      }
    })
  }
})
