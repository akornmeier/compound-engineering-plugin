#!/usr/bin/env python3
"""Staging state machine for ce-learning-sweep's write edge.

Owns the git mechanics of staged capture:
  - worktree from origin/main (never local main — stale-base contamination)
  - atomic finalize/abort
  - push, PR creation, merge, teardown

ce-compound dispatches are NOT in this script. The skill invokes ce-compound
mode:headless per approved keeper between `open` and `finalize`, branching on
the terminal signals `Documentation complete` / `Documentation skipped`.

Usage:
    python3 stage-captures.py open --run-id <id> --source-pr <n>
    python3 stage-captures.py finalize --run-id <id> --source-pr <n> --title <t> --body-file <path>
    python3 stage-captures.py merge --run-id <id> --pr <n> [--validator <path>] [--timeout <s>]
    python3 stage-captures.py abort --run-id <id>
    python3 stage-captures.py teardown --run-id <id>

All subcommands emit a single JSON envelope to stdout and exit 0 for every
recognized state. Non-zero exit is reserved for unexpected internal errors.

Statuses (envelope ``status``):
    worktree_open       open succeeded; worktree ready for ce-compound dispatches
    invalid_source_pr   source-pr is not a positive integer; no git/gh invoked
    no_forge            gh binary absent or not authenticated (open/finalize gh-check/merge)
    staging_error       git operation failed (open: fetch/worktree-add; finalize: commit/push)
    invalid_body_file   finalize: --body-file path not found or empty before any git mutation
    nothing_staged      finalize: nothing in docs/solutions to commit
    pr_open             finalize: PR created; number + url in envelope
    orphan_branch       finalize: push ok but gh pr create failed twice; branch named
    validation_failed   merge: validator exited non-zero
    awaiting_attention  merge: checks red/timeout; comment posted on PR (warnings if comment failed)
    merged              merge: squash-merged and branch deleted
    rolled_back         abort: worktree removed and local branch ref deleted
    torn_down           teardown: worktree removed (idempotent)
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import NoReturn

# ---------------------------------------------------------------------------
# Published constants — pinned by tests/learning-sweep-staging.test.ts
# ---------------------------------------------------------------------------

LABEL = "learning-capture"
BRANCH_PREFIX = "learning-capture/"

# Allowlisted path specs for finalize staging (prevention-first per P3).
ALLOWED_STAGE_SPECS = ["docs/solutions"]

# Wall-clock ceiling for gh subprocess calls.
GH_TIMEOUT_SECONDS = 60

# Default timeout for waiting on PR checks (seconds).
DEFAULT_CHECKS_TIMEOUT = 600

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def emit(envelope: dict) -> NoReturn:
    json.dump(envelope, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)


def fail_internal(msg: str) -> NoReturn:
    sys.stderr.write(f"stage-captures: {msg}\n")
    sys.exit(2)


def worktree_dir(run_id: str) -> Path:
    return Path(f"/tmp/compound-engineering/ce-learning-sweep/{run_id}/staging-worktree")


def branch_name(source_pr: int, run_id: str) -> str:
    return f"{BRANCH_PREFIX}pr-{source_pr}-{run_id}"


def run_cmd(args, cwd=None, timeout=None, capture=True):
    """Run a subprocess. Returns CompletedProcess. Raises on timeout."""
    return subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        capture_output=capture,
        text=True,
        check=False,
        timeout=timeout or GH_TIMEOUT_SECONDS,
    )


def gh_available() -> bool:
    try:
        proc = run_cmd(["gh", "auth", "status"])
    except (OSError, FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


# ---------------------------------------------------------------------------
# Label helpers
# ---------------------------------------------------------------------------


def ensure_label(label: str, worktree: Path) -> dict | None:
    """Ensure the label exists. Returns warning dict or None.

    `gh label create --force` is idempotent — creates when absent, updates
    when present — so no existence pre-check is needed.
    """
    try:
        create = run_cmd(
            ["gh", "label", "create", label, "--color", "0075ca", "--force"],
            cwd=worktree,
        )
        if create.returncode != 0:
            return {
                "type": "label_create_failed",
                "label": label,
                "detail": create.stderr.strip()[:200],
            }
    except (OSError, FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return {"type": "label_create_failed", "label": label, "detail": str(exc)}
    return None


# ---------------------------------------------------------------------------
# Subcommand: open
# ---------------------------------------------------------------------------


def parse_source_pr(raw: str) -> int:
    """Validate the source PR is a positive integer BEFORE any git/gh
    invocation; emits `invalid_source_pr` (and exits) otherwise."""
    try:
        source_pr = int(raw)
        if source_pr <= 0:
            raise ValueError("non-positive")
    except (ValueError, TypeError):
        emit({"status": "invalid_source_pr", "source_pr": raw})
    return source_pr


def cmd_open(args) -> NoReturn:
    run_id: str = args.run_id
    source_pr = parse_source_pr(args.source_pr)

    if not gh_available():
        emit({"status": "no_forge", "detail": "gh CLI unavailable or not authenticated"})

    wt_dir = worktree_dir(run_id)
    branch = branch_name(source_pr, run_id)

    # Ensure parent directory exists.
    wt_dir.parent.mkdir(parents=True, exist_ok=True)

    # Fetch origin/main fresh — NEVER use local main (stale-base contamination).
    try:
        fetch = run_cmd(["git", "fetch", "--no-tags", "origin", "main"])
    except subprocess.TimeoutExpired:
        emit({"status": "staging_error", "detail": "git fetch timed out"})
    if fetch.returncode != 0:
        emit({
            "status": "staging_error",
            "detail": fetch.stderr.strip()[:300] or "git fetch origin main failed",
        })

    # Add worktree on the freshly fetched origin/main.
    try:
        wt_add = run_cmd(
            ["git", "worktree", "add", str(wt_dir), "-b", branch, "origin/main"]
        )
    except subprocess.TimeoutExpired:
        emit({"status": "staging_error", "detail": "git worktree add timed out"})
    if wt_add.returncode != 0:
        emit({
            "status": "staging_error",
            "detail": wt_add.stderr.strip()[:300] or "git worktree add failed",
        })

    emit({
        "status": "worktree_open",
        "run_id": run_id,
        "source_pr": source_pr,
        "worktree_path": str(wt_dir),
        "branch": branch,
    })


# ---------------------------------------------------------------------------
# Subcommand: finalize
# ---------------------------------------------------------------------------


def cmd_finalize(args) -> NoReturn:
    run_id: str = args.run_id
    title: str = args.title
    body_file: str = args.body_file
    source_pr = parse_source_pr(args.source_pr)

    # Validate body-file FIRST — before any git mutation.  A bad path would
    # otherwise strand a pushed branch with no PR body to create from.
    body_path = Path(body_file)
    if not body_path.exists() or body_path.stat().st_size == 0:
        emit({
            "status": "invalid_body_file",
            "detail": f"body-file not found or empty: {body_file}",
        })

    if not gh_available():
        emit({"status": "no_forge", "detail": "gh CLI unavailable or not authenticated"})

    wt_dir = worktree_dir(run_id)
    branch = branch_name(source_pr, run_id)

    # Stage only the allowlisted paths (prevention-first).
    for spec in ALLOWED_STAGE_SPECS:
        run_cmd(["git", "add", "--", spec], cwd=wt_dir)

    # Check for warnings: any OTHER modified/untracked path in the worktree.
    status_proc = run_cmd(["git", "status", "--porcelain"], cwd=wt_dir)
    warnings = []
    staged_count = 0
    if status_proc.returncode == 0:
        for line in status_proc.stdout.splitlines():
            if not line.strip():
                continue
            xy = line[:2]
            path_part = line[3:].strip()
            staged_flag = xy[0]   # index status
            worktree_flag = xy[1] # working-tree status
            if staged_flag not in (" ", "?"):
                staged_count += 1
            else:
                # Not staged but present in worktree — warn.
                if worktree_flag != " " or staged_flag == "?":
                    warnings.append({"type": "unstaged_path", "path": path_part})

    if staged_count == 0:
        emit({
            "status": "nothing_staged",
            "run_id": run_id,
            "source_pr": source_pr,
            "warnings": warnings,
        })

    # Commit.
    commit_msg = title if title else f"docs(learnings): capture entries from PR #{source_pr}"
    commit_proc = run_cmd(
        ["git", "commit", "-m", commit_msg],
        cwd=wt_dir,
    )
    if commit_proc.returncode != 0:
        emit({
            "status": "staging_error",
            "detail": commit_proc.stderr.strip()[:300] or "git commit failed",
        })

    # Push.
    push_proc = run_cmd(
        ["git", "push", "-u", "origin", branch],
        cwd=wt_dir,
    )
    if push_proc.returncode != 0:
        emit({
            "status": "staging_error",
            "detail": push_proc.stderr.strip()[:300] or "git push failed",
        })

    # Ensure label exists (warning if it fails, not a failure state).
    label_warning = ensure_label(LABEL, wt_dir)
    result_warnings = list(warnings)
    if label_warning:
        result_warnings.append(label_warning)

    # gh pr create — retry once on failure.
    pr_url = None
    pr_number = None
    last_err = ""
    for attempt in range(2):
        pr_proc = run_cmd(
            [
                "gh", "pr", "create",
                "--title", title,
                "--body-file", body_file,
                "--label", LABEL,
                "--head", branch,
            ],
            cwd=wt_dir,
        )
        if pr_proc.returncode == 0:
            pr_url = pr_proc.stdout.strip()
            # Extract PR number from URL (e.g. .../pull/42).
            if "/" in pr_url:
                try:
                    pr_number = int(pr_url.rstrip("/").rsplit("/", 1)[-1])
                except (ValueError, IndexError):
                    pr_number = None
            break
        last_err = pr_proc.stderr.strip()[:300]
        if attempt == 0:
            time.sleep(2)

    if pr_url is None:
        emit({
            "status": "orphan_branch",
            "run_id": run_id,
            "source_pr": source_pr,
            "branch": branch,
            "detail": last_err or "gh pr create failed twice",
        })

    envelope = {
        "status": "pr_open",
        "run_id": run_id,
        "source_pr": source_pr,
        "branch": branch,
        "pr_number": pr_number,
        "pr_url": pr_url,
    }
    if result_warnings:
        envelope["warnings"] = result_warnings
    emit(envelope)


# ---------------------------------------------------------------------------
# Subcommand: merge
# ---------------------------------------------------------------------------


def cmd_merge(args) -> NoReturn:
    run_id: str = args.run_id
    pr_number: int = args.pr
    checks_timeout: int = getattr(args, "timeout", DEFAULT_CHECKS_TIMEOUT)

    # Resolve the validator path.
    # Default: installed/trusted copy adjacent to this script, NOT the branch copy.
    if args.validator:
        validator_path = Path(args.validator)
    else:
        # Resolve relative to this script's own location — CI tamper-resistance.
        validator_path = Path(__file__).parent / "validate-staged-keepers.py"

    if not validator_path.exists():
        # The gate is hard: a missing validator is a broken install, never a
        # reason to merge unvalidated.
        emit({
            "status": "validation_failed",
            "pr": pr_number,
            "detail": f"validator missing at {validator_path} — refusing to merge unvalidated",
        })

    if not gh_available():
        emit({"status": "no_forge", "detail": "gh CLI unavailable or not authenticated"})

    # Re-run validation against the trusted copy, inside the staging worktree
    # (HEAD there is the capture branch the validator diffs against origin/main).
    wt_dir = worktree_dir(run_id)
    if not wt_dir.exists():
        emit({
            "status": "validation_failed",
            "pr": pr_number,
            "detail": f"staging worktree not found at {wt_dir} — cannot re-validate",
        })

    # Resolve the worktree's actual branch so the validator is not misled by
    # GITHUB_HEAD_REF (which, inside a pull_request Actions context, points to
    # the SOURCE PR's head ref, not the capture branch).
    branch_proc = run_cmd(["git", "branch", "--show-current"], cwd=wt_dir)
    wt_branch = branch_proc.stdout.strip() if branch_proc.returncode == 0 else ""

    val_cmd = ["python3", str(validator_path), "--repo", str(wt_dir)]
    if wt_branch:
        val_cmd += ["--branch", wt_branch]

    try:
        val_proc = subprocess.run(
            val_cmd,
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        emit({
            "status": "validation_failed",
            "pr": pr_number,
            "detail": "validator timed out",
        })
    if val_proc.returncode != 0:
        emit({
            "status": "validation_failed",
            "pr": pr_number,
            "detail": (val_proc.stdout + val_proc.stderr).strip()[:500],
        })

    # Watch checks with bounded timeout.  gh pr checks does NOT support a
    # --timeout flag (gh 2.94+); the subprocess-level timeout= already bounds
    # wall clock.  Only --watch, --interval (-i), and --fail-fast are valid.
    checks_green = False
    try:
        watch_proc = run_cmd(
            ["gh", "pr", "checks", str(pr_number), "--watch"],
            timeout=checks_timeout + 30,
        )
        checks_green = watch_proc.returncode == 0
    except subprocess.TimeoutExpired:
        checks_green = False

    if not checks_green:
        # Comment on the PR and report awaiting_attention.
        comment_warnings = []
        comment_proc = run_cmd([
            "gh", "pr", "comment", str(pr_number),
            "--body", "Automated merge paused: checks did not pass. Please review and merge manually.",
        ])
        if comment_proc.returncode != 0:
            comment_warnings.append({
                "type": "comment_failed",
                "detail": comment_proc.stderr.strip()[:200],
            })
        envelope: dict = {
            "status": "awaiting_attention",
            "pr": pr_number,
            "detail": "checks red or timed out; comment posted",
        }
        if comment_warnings:
            envelope["warnings"] = comment_warnings
        emit(envelope)

    # Merge.
    merge_proc = run_cmd(
        ["gh", "pr", "merge", str(pr_number), "--squash", "--delete-branch"]
    )
    if merge_proc.returncode != 0:
        emit({
            "status": "awaiting_attention",
            "pr": pr_number,
            "detail": merge_proc.stderr.strip()[:300] or "gh pr merge failed",
        })

    # Teardown worktree (wt_dir resolved above for validation).
    if wt_dir.exists():
        run_cmd(["git", "worktree", "remove", "--force", str(wt_dir)])

    emit({"status": "merged", "pr": pr_number, "run_id": run_id})


# ---------------------------------------------------------------------------
# Subcommand: abort
# ---------------------------------------------------------------------------


def cmd_abort(args) -> NoReturn:
    run_id: str = args.run_id
    wt_dir = worktree_dir(run_id)

    # Determine branch from worktree if possible.
    branch = None
    if wt_dir.exists():
        result = run_cmd(["git", "branch", "--show-current"], cwd=wt_dir)
        if result.returncode == 0:
            branch = result.stdout.strip()
        # Remove worktree.
        run_cmd(["git", "worktree", "remove", "--force", str(wt_dir)])

    # Delete local branch ref (no remote push has occurred on the abort path).
    if branch:
        run_cmd(["git", "branch", "-D", branch])

    emit({"status": "rolled_back", "run_id": run_id, "branch": branch})


# ---------------------------------------------------------------------------
# Subcommand: teardown
# ---------------------------------------------------------------------------


def cmd_teardown(args) -> NoReturn:
    run_id: str = args.run_id
    wt_dir = worktree_dir(run_id)

    if wt_dir.exists():
        run_cmd(["git", "worktree", "remove", "--force", str(wt_dir)])

    # Idempotent: second call exits cleanly even if already removed.
    emit({"status": "torn_down", "run_id": run_id})


# ---------------------------------------------------------------------------
# Argument parsing and dispatch
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="stage-captures",
        description="Staging state machine for ce-learning-sweep captures.",
    )
    sub = parser.add_subparsers(dest="subcommand", required=True)

    # open
    p_open = sub.add_parser("open")
    p_open.add_argument("--run-id", required=True)
    p_open.add_argument("--source-pr", required=True)

    # finalize
    p_fin = sub.add_parser("finalize")
    p_fin.add_argument("--run-id", required=True)
    p_fin.add_argument("--source-pr", required=True)
    p_fin.add_argument("--title", required=True)
    p_fin.add_argument("--body-file", required=True)

    # merge
    p_merge = sub.add_parser("merge")
    p_merge.add_argument("--run-id", required=True)
    p_merge.add_argument("--pr", required=True, type=int)
    p_merge.add_argument("--validator", default=None)
    p_merge.add_argument("--timeout", type=int, default=DEFAULT_CHECKS_TIMEOUT)

    # abort
    p_abort = sub.add_parser("abort")
    p_abort.add_argument("--run-id", required=True)

    # teardown
    p_teardown = sub.add_parser("teardown")
    p_teardown.add_argument("--run-id", required=True)

    return parser


def main(argv) -> None:
    parser = build_parser()
    args = parser.parse_args(argv[1:])
    dispatch = {
        "open": cmd_open,
        "finalize": cmd_finalize,
        "merge": cmd_merge,
        "abort": cmd_abort,
        "teardown": cmd_teardown,
    }
    handler = dispatch.get(args.subcommand)
    if not handler:
        fail_internal(f"unknown subcommand: {args.subcommand}")
    handler(args)


if __name__ == "__main__":
    main(sys.argv)
