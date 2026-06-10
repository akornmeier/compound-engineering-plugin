#!/usr/bin/env python3
"""Mine one merged PR for ce-learning-sweep candidate-learning material.

Usage:
    python3 fetch-pr-data.py <pr-ref>

<pr-ref> accepts any of: a bare number (``13``), ``#13``, a full PR URL
(``https://github.com/owner/repo/pull/13``), or ``owner/repo#13``.

The script always emits a single JSON envelope to stdout and exits 0 for every
*recognized* state. The envelope's top-level ``status`` field is the
machine-readable result; the caller branches on it rather than on the exit
code. A non-zero exit is reserved for genuinely unexpected internal errors
(e.g. an unparseable reference) so the orchestrator can tell "PR is in state X"
apart from "the script itself broke".

States (envelope ``status``):
    ok            merged PR; diff + commits + threads mined.
    not_found     gh could not resolve the PR number.
    not_merged    PR exists but is not merged. ``detail`` names which:
                  open / closed_unmerged / draft.
    no_forge      gh binary is absent or gh is not authenticated. A PR
                  reference cannot be resolved without forge access, so this is
                  a skip, not a degraded run.
    repo_mismatch the ref names a repo that is not the working directory's
                  origin remote.
    fetch_failed  diff or commits fetch failed on a valid merged PR. The diff
                  is the primary mining input, so losing it is terminal.

Mining (status ``ok``) covers three inputs, fetched via the gh API rather than
local git diffs (a local diff can be contaminated by a stale base branch):
    diff_raw      PR diff with lockfiles and generated files excluded.
    commits_raw   commit headlines + bodies from ``gh pr view --json commits``.
                  Verified live: gh returns the PR branch's commits even after
                  a squash merge, so this survives squash-merged PRs.
    threads_raw   review threads, resolved AND unresolved, via paginated
                  GraphQL. ``isResolved`` is preserved per thread.

R6 (untrusted input): mined content is nested under the ``*_raw`` keys above so
the data/instruction boundary is structural -- the consuming skill frames every
string under those keys as data to analyze, never as instructions to run.

Degradation vs. skip:
    - Threads inaccessible while gh otherwise works -> proceed on diff +
      commits and set ``degraded_inputs`` naming what is missing. A PR with
      zero threads is a normal state, NOT degradation (empty list, no flag).
    - Diff or commits fetch failing -> fetch_failed (terminal), since the diff
      is the primary input.

Caps (R5): diff bytes and thread count are capped by the named constants below.
On truncation the relevant ``truncations`` flag is set. Exclusions and
truncations are both disclosed through the ``flags`` block.

Pure-stdlib (no third-party deps). All forge access goes through the ``gh``
CLI, which the test harness replaces with a PATH shim to exercise every state
without network.
"""
import json
import os
import re
import subprocess
import sys
from typing import NoReturn

# --- Caps and exclusion policy (named constants per R5) --------------------

# Diff is the primary mining input but the model never needs the raw bytes of a
# huge mechanical change. Cap the post-exclusion diff; flag truncation when hit.
MAX_DIFF_BYTES = 200_000

# Resolved-thread volume on old PRs dwarfs the unresolved-only set the resolver
# skill fetches, so cap the merged thread list and flag truncation when hit.
MAX_THREADS = 200

# Inline comments per thread we keep; deep threads are rare and the head of the
# thread carries the reviewer's point.
MAX_COMMENTS_PER_THREAD = 20

# Per-page size for the GraphQL thread query (matched to gh's --paginate loop).
THREADS_PAGE_SIZE = 100

# Paths excluded from the mined diff: lockfiles + generated/minified artifacts.
# A learning never lives in a regenerated lockfile, and the raw bytes crowd out
# real signal. Matched against the diff's ``+++ b/<path>`` (and ``--- a/<path>``
# for deletions) header lines.
LOCKFILE_NAMES = {
    "package-lock.json",
    "bun.lockb",
    "bun.lock",
    "yarn.lock",
    "Gemfile.lock",
    "Cargo.lock",
    "poetry.lock",
    "composer.lock",
    "pnpm-lock.yaml",
}
# Suffix-based exclusions (lockfiles by extension, minified bundles).
EXCLUDE_SUFFIXES = (".lock", ".min.js", ".min.css")
# Path-segment exclusions: any hunk whose file sits under a generated dir.
GENERATED_DIR_SEGMENTS = ("node_modules/", "dist/", "build/", "vendor/", ".next/")


def emit(envelope: dict) -> NoReturn:
    """Write the single JSON envelope to stdout and exit 0."""
    json.dump(envelope, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)


def fail_internal(msg: str) -> NoReturn:
    """Write msg to stderr and exit 2 (unexpected internal error)."""
    sys.stderr.write(f"fetch-pr-data: {msg}\n")
    sys.exit(2)


# --- Reference parsing and repo resolution ---------------------------------

_URL_RE = re.compile(
    r"^https?://[^/]+/(?P<owner>[^/]+)/(?P<repo>[^/]+)/pull/(?P<num>\d+)\b"
)
_SLUG_RE = re.compile(r"^(?P<owner>[^/\s]+)/(?P<repo>[^/#\s]+)#(?P<num>\d+)$")
_BARE_RE = re.compile(r"^#?(?P<num>\d+)$")


def parse_ref(ref: str):
    """Return (owner_or_None, repo_or_None, number) from a PR reference.

    A bare/``#`` number carries no repo (owner/repo are None and resolve from
    origin). URL and ``owner/repo#n`` forms carry an explicit repo that the
    caller checks against origin.
    """
    ref = ref.strip()
    m = _URL_RE.match(ref)
    if m:
        return m.group("owner"), m.group("repo"), int(m.group("num"))
    m = _SLUG_RE.match(ref)
    if m:
        return m.group("owner"), m.group("repo"), int(m.group("num"))
    m = _BARE_RE.match(ref)
    if m:
        return None, None, int(m.group("num"))
    fail_internal(f"unrecognized PR reference: {ref!r}")


def origin_slug():
    """Resolve (owner, repo) from the checkout's origin remote.

    Anchor on origin -- the branch's push target / where its PR lives -- never
    on gh's configured default-repo, which points at the upstream parent in a
    fork and would query a foreign repo.
    """
    try:
        url = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, check=False,
        ).stdout.strip()
    except OSError:
        return None, None
    if not url:
        return None, None
    # Strip the transport prefix (git@host:, ssh://git@host/, https://host/)
    # and a trailing .git, leaving owner/repo.
    slug = re.sub(r"^(git@[^:]+:|ssh://git@[^/]+/|https?://[^/]+/)", "", url)
    slug = re.sub(r"\.git$", "", slug)
    parts = slug.split("/")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        return None, None
    return parts[0], parts[1]


# --- gh availability -------------------------------------------------------

def gh_available() -> bool:
    """True only when the gh binary exists AND gh is authenticated.

    Either condition failing means a PR reference cannot be resolved at all,
    which is the no_forge skip tier -- not a degraded run.
    """
    try:
        probe = subprocess.run(
            ["gh", "auth", "status"],
            capture_output=True, text=True, check=False,
        )
    except (OSError, FileNotFoundError):
        return False
    return probe.returncode == 0


def gh_json(args):
    """Run a ``gh ... --json`` command. Return (ok, parsed_or_stderr).

    ok=False carries the captured stderr so callers can distinguish a
    not-found PR from a transient failure by inspecting the message.
    """
    try:
        proc = subprocess.run(
            ["gh"] + args, capture_output=True, text=True, check=False,
        )
    except (OSError, FileNotFoundError) as exc:
        return False, str(exc)
    if proc.returncode != 0:
        return False, proc.stderr
    try:
        return True, json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return False, f"unparseable gh output: {exc}"


# --- Diff filtering and capping --------------------------------------------

def _diff_path(header_line: str):
    """Extract the file path from a ``+++ b/<path>`` / ``--- a/<path>`` line."""
    # e.g. "+++ b/path/to/file" -> "path/to/file"; "/dev/null" for adds/deletes.
    rest = header_line[4:].strip()
    if rest in ("/dev/null", ""):
        return None
    if rest.startswith(("a/", "b/")):
        rest = rest[2:]
    return rest


def _is_excluded(path: str) -> bool:
    if path is None:
        return False
    base = path.rsplit("/", 1)[-1]
    if base in LOCKFILE_NAMES:
        return True
    if path.endswith(EXCLUDE_SUFFIXES):
        return True
    if any(seg in path for seg in GENERATED_DIR_SEGMENTS):
        return True
    return False


def filter_diff(diff_text: str):
    """Drop hunks for excluded files. Return (filtered_text, excluded_paths).

    A unified diff is a sequence of per-file blocks each opening with
    ``diff --git a/<x> b/<y>``. We split on those headers, decide per block
    using its ``+++``/``---`` path, and keep or drop the whole block.
    """
    excluded: list[str] = []
    if not diff_text:
        return "", excluded

    blocks: list[str] = []
    current: list[str] = []
    for line in diff_text.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if current:
                blocks.append("".join(current))
            current = [line]
        else:
            current.append(line)
    if current:
        blocks.append("".join(current))

    kept: list[str] = []
    for block in blocks:
        path = None
        for bl in block.splitlines():
            if bl.startswith("+++ ") or bl.startswith("--- "):
                p = _diff_path(bl)
                if p is not None:
                    path = p
                    break
        if path is not None and _is_excluded(path):
            excluded.append(path)
            continue
        kept.append(block)

    return "".join(kept), excluded


# --- GraphQL thread mining (adapted from get-pr-comments) -------------------

# Each top-level connection must be paginated in its own --paginate query
# because gh's --paginate only follows the outermost pageInfo per response.
# We query a single connection (reviewThreads), so one paginated query suffices,
# but pagination still follows only that outermost pageInfo. Unlike
# get-pr-comments we keep resolved AND unresolved threads -- no isResolved
# filter -- so the sweep can mine settled review discussion too.
_THREADS_QUERY = """
query Threads($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: %d, after: $endCursor) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: %d) {
            nodes {
              author { login }
              body
              url
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
""" % (THREADS_PAGE_SIZE, MAX_COMMENTS_PER_THREAD)


def fetch_threads(owner: str, repo: str, number: int):
    """Return (ok, threads_list_or_None, truncated_bool).

    ok=False means threads were inaccessible while gh otherwise works -> the
    caller degrades rather than fails. ``--paginate --slurp`` returns a JSON
    array of per-page response objects; we flatten ``reviewThreads.nodes``
    across pages into one complete list.
    """
    try:
        proc = subprocess.run(
            [
                "gh", "api", "graphql", "--paginate", "--slurp",
                "-f", f"owner={owner}",
                "-f", f"repo={repo}",
                "-F", f"pr={number}",
                "-f", f"query={_THREADS_QUERY}",
            ],
            capture_output=True, text=True, check=False,
        )
    except (OSError, FileNotFoundError):
        return False, None, False
    if proc.returncode != 0:
        return False, None, False
    try:
        pages = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return False, None, False

    nodes: list = []
    for page in pages:
        pr = (
            page.get("data", {})
            .get("repository", {})
            .get("pullRequest")
        )
        if not pr:
            continue
        nodes.extend(pr.get("reviewThreads", {}).get("nodes", []))

    truncated = len(nodes) > MAX_THREADS
    if truncated:
        nodes = nodes[:MAX_THREADS]
    return True, nodes, truncated


# --- Main state machine ----------------------------------------------------

def main(argv) -> None:
    if len(argv) != 2:
        fail_internal(f"usage: {os.path.basename(argv[0])} <pr-ref>")

    ref_owner, ref_repo, number = parse_ref(argv[1])

    # Repo-match guard: a ref naming an explicit repo must match origin. We
    # check this before touching gh so a cross-repo ref skips cheaply.
    o_owner, o_repo = origin_slug()
    if ref_owner is not None and ref_repo is not None:
        if (ref_owner, ref_repo) != (o_owner, o_repo):
            emit({
                "status": "repo_mismatch",
                "pr": number,
                "detail": (
                    f"ref repo {ref_owner}/{ref_repo} does not match origin "
                    f"{o_owner}/{o_repo}"
                ),
            })
        owner, repo = ref_owner, ref_repo
    else:
        owner, repo = o_owner, o_repo

    if not owner or not repo:
        # No explicit repo in the ref and origin could not be resolved -> we
        # cannot address a PR. Treat as no_forge (forge context unavailable).
        emit({
            "status": "no_forge",
            "pr": number,
            "detail": "could not resolve origin repository",
        })

    if not gh_available():
        emit({
            "status": "no_forge",
            "pr": number,
            "detail": "gh CLI unavailable or not authenticated",
        })

    # Single state probe BEFORE any mining. Address by number, never by
    # branch-name search.
    ok, payload = gh_json([
        "pr", "view", str(number),
        "--repo", f"{owner}/{repo}",
        "--json", "state,mergedAt,isDraft,number,title",
    ])
    if not ok:
        msg = payload if isinstance(payload, str) else ""
        if "Could not resolve" in msg or "no pull requests found" in msg.lower():
            emit({"status": "not_found", "pr": number})
        # Any other non-zero from gh after the auth check passed: forge access
        # degraded (auth expired, network) -> no_forge skip tier.
        emit({
            "status": "no_forge",
            "pr": number,
            "detail": msg.strip()[:300] or "gh pr view failed",
        })

    state = (payload.get("state") or "").upper()
    is_draft = bool(payload.get("isDraft"))
    title = payload.get("title") or ""

    if state != "MERGED":
        if is_draft:
            detail = "draft"
        elif state == "OPEN":
            detail = "open"
        elif state == "CLOSED":
            detail = "closed_unmerged"
        else:
            detail = state.lower() or "unknown"
        emit({
            "status": "not_merged",
            "pr": number,
            "detail": detail,
            "title": title,
        })

    # --- Mining (status ok). Diff and commits are primary; their failure is
    # terminal (fetch_failed). Threads are degradable.

    # Survives squash merge (verified live against this repo's PR #13).
    ok_commits, commits_payload = gh_json([
        "pr", "view", str(number),
        "--repo", f"{owner}/{repo}",
        "--json", "commits",
    ])
    if not ok_commits:
        emit({
            "status": "fetch_failed",
            "pr": number,
            "detail": "commits fetch failed",
        })
    commits = [
        {
            "oid": c.get("oid", ""),
            "headline": c.get("messageHeadline", ""),
            "body": c.get("messageBody", ""),
        }
        for c in commits_payload.get("commits", [])
    ]

    # Diff via gh pr diff (forge API, not a local git diff).
    try:
        diff_proc = subprocess.run(
            ["gh", "pr", "diff", str(number), "--repo", f"{owner}/{repo}"],
            capture_output=True, text=True, check=False,
        )
    except (OSError, FileNotFoundError):
        emit({"status": "fetch_failed", "pr": number, "detail": "diff fetch failed"})
    if diff_proc.returncode != 0:
        emit({
            "status": "fetch_failed",
            "pr": number,
            "detail": (diff_proc.stderr.strip()[:300] or "diff fetch failed"),
        })

    filtered_diff, excluded_paths = filter_diff(diff_proc.stdout)
    diff_bytes = filtered_diff.encode("utf-8")
    diff_truncated = len(diff_bytes) > MAX_DIFF_BYTES
    if diff_truncated:
        # Truncate on a byte boundary, then back off to the last clean newline
        # so the cut diff stays line-aligned.
        clipped = diff_bytes[:MAX_DIFF_BYTES].decode("utf-8", errors="ignore")
        nl = clipped.rfind("\n")
        filtered_diff = clipped[:nl] if nl > 0 else clipped

    # Threads: degradable. Failure here proceeds on diff + commits.
    threads_ok, threads, threads_truncated = fetch_threads(owner, repo, number)

    flags = {
        "excluded_paths": excluded_paths,
        "truncations": {
            "diff": diff_truncated,
            "threads": threads_truncated,
        },
    }
    degraded_inputs: list[str] = []
    if not threads_ok:
        # gh works but threads are inaccessible -> degrade, naming the gap.
        # Zero threads is NOT degradation; that is an empty list with no flag.
        degraded_inputs.append("review_threads")
        threads = []
    if degraded_inputs:
        flags["degraded_inputs"] = degraded_inputs

    emit({
        "status": "ok",
        "pr": number,
        "repo": f"{owner}/{repo}",
        "title": title,
        "diff_raw": filtered_diff,
        "commits_raw": commits,
        "threads_raw": threads,
        "flags": flags,
    })


if __name__ == "__main__":
    main(sys.argv)
