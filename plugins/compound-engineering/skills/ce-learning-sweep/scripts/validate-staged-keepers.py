#!/usr/bin/env python3
"""Hard re-validation gate for staged capture PRs.

Runs as a CI check and as the merge path's final gate.  Every staged capture
PR that touches the learning-corpus must pass before landing.

Usage:
    python3 validate-staged-keepers.py [--repo <path>] [--branch <name>]
                                       [--base <ref>] [--no-fetch]

Exit codes:
    0  — pass (or skipped: branch is not a capture branch)
    1  — one or more gate failures; JSON report on stdout

Activation discriminator: if the branch does NOT start with ``learning-capture/``,
emit status ``skipped_not_capture_branch`` and exit 0.  Never key on file paths
alone — a human adding a solutions doc in a normal PR must be unaffected.

Statuses (``status`` field in output envelope):
    skipped_not_capture_branch  branch not a capture PR; gate does not apply
    pass                        all gates passed; staged diff is clean
    failed                      one or more gate violations; see ``failures``

Failure ``type`` values in the ``failures`` list:
    allowlist_violation         staged path not under docs/solutions/**/*.md
    traversal_path              staged path contains ``..`` or is absolute
    entry_too_large             single entry diff exceeds PER_ENTRY_CAP_BYTES
    pr_too_large                total diff exceeds PR_CAP_BYTES
    corpus_collision            new entry overlaps an existing corpus doc
    stale_update_in_place       modified file also changed on origin/main since branch base
    malformed_staged_file       staged file has unparseable frontmatter (warning only)

Published constants — pinned by tests/learning-sweep-staging.test.ts:
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Published constants — pinned by tests/learning-sweep-staging.test.ts
# ---------------------------------------------------------------------------

LABEL = "learning-capture"
BRANCH_PREFIX = "learning-capture/"

# Gate caps.
PER_ENTRY_CAP_BYTES = 32_768   # 32 KB per staged entry diff
PR_CAP_BYTES = 163_840         # 160 KB total diff across all staged entries

# Allowlisted path pattern for staged files.
ALLOWED_PREFIX = "docs/solutions/"
ALLOWED_SUFFIX = ".md"

# Overlap score thresholds for corpus collision detection.
# Three-dimension deterministic score: title, tags, module.
# A score >= this value is a collision.
OVERLAP_COLLISION_THRESHOLD = 2


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def run_git(args: list[str], cwd: str | None = None, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git"] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        check=check,
    )


def emit_pass() -> None:
    json.dump({"status": "pass"}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)


def emit_skipped(reason: str) -> None:
    json.dump({"status": "skipped_not_capture_branch", "reason": reason}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)


def emit_failed(failures: list[dict], warnings: list[dict]) -> None:
    out: dict[str, Any] = {"status": "failed", "failures": failures}
    if warnings:
        out["warnings"] = warnings
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(1)


def emit_pass_with_warnings(warnings: list[dict]) -> None:
    json.dump({"status": "pass", "warnings": warnings}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)


# ---------------------------------------------------------------------------
# Branch detection
# ---------------------------------------------------------------------------


def detect_branch(branch_arg: str | None, repo_root: str) -> str:
    """Return the current branch name. Prefer CLI arg, then env, then git."""
    if branch_arg:
        return branch_arg
    env_ref = os.environ.get("GITHUB_HEAD_REF", "").strip()
    if env_ref:
        return env_ref
    proc = run_git(["branch", "--show-current"], cwd=repo_root)
    return proc.stdout.strip()


# ---------------------------------------------------------------------------
# Repo root detection
# ---------------------------------------------------------------------------


def find_repo_root(start: str) -> str:
    proc = run_git(["rev-parse", "--show-toplevel"], cwd=start)
    if proc.returncode != 0:
        sys.stderr.write("validate-staged-keepers: not inside a git repository\n")
        sys.exit(2)
    return proc.stdout.strip()


# ---------------------------------------------------------------------------
# Diff parsing
# ---------------------------------------------------------------------------


def get_diff_name_status(repo_root: str, base_ref: str) -> list[tuple[str, str]]:
    """Return list of (status_char, path) for three-dot diff against base_ref.

    Status chars: A=added, M=modified, D=deleted, R=renamed, C=copied, etc.
    We only care about A, M for gate purposes; others are collected too.
    """
    proc = run_git(
        ["diff", "--name-status", f"{base_ref}...HEAD"],
        cwd=repo_root,
    )
    if proc.returncode != 0:
        sys.stderr.write(f"validate-staged-keepers: git diff failed: {proc.stderr}\n")
        sys.exit(2)
    results = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t", 2)
        if len(parts) < 2:
            continue
        status = parts[0][0]  # First char: A, M, D, R, C, etc.
        path_str = parts[-1]  # Last field is the new path for renames; original otherwise
        results.append((status, path_str))
    return results


def get_entry_diff_size(repo_root: str, base_ref: str, file_path: str) -> int:
    """Return the byte size of the diff for a single file."""
    proc = run_git(
        ["diff", f"{base_ref}...HEAD", "--", file_path],
        cwd=repo_root,
    )
    return len(proc.stdout.encode("utf-8"))


def get_total_diff_size(repo_root: str, base_ref: str, paths: list[str]) -> int:
    """Return total diff size in bytes across all given paths."""
    if not paths:
        return 0
    proc = run_git(
        ["diff", f"{base_ref}...HEAD", "--"] + paths,
        cwd=repo_root,
    )
    return len(proc.stdout.encode("utf-8"))


# ---------------------------------------------------------------------------
# Staleness: stale_update_in_place detection
# ---------------------------------------------------------------------------


def get_merge_base(repo_root: str, base_ref: str) -> str:
    """Return the merge-base commit SHA between HEAD and base_ref."""
    proc = run_git(["merge-base", "HEAD", base_ref], cwd=repo_root)
    if proc.returncode != 0:
        return ""
    return proc.stdout.strip()


def origin_main_modified_since(repo_root: str, merge_base: str, file_path: str) -> bool:
    """Return True if origin/main has modified file_path since the merge base."""
    if not merge_base:
        return False
    proc = run_git(
        ["log", "--oneline", f"{merge_base}..origin/main", "--", file_path],
        cwd=repo_root,
    )
    return bool(proc.stdout.strip())


# ---------------------------------------------------------------------------
# Frontmatter parsing (stdlib-only, tolerant — same shape as scan-corpus.py)
# ---------------------------------------------------------------------------


def split_frontmatter(text: str) -> tuple[list[str], bool]:
    lines = text.split("\n")
    if not lines or lines[0].rstrip() != "---":
        return [], False
    for i in range(1, len(lines)):
        if lines[i].rstrip() == "---":
            return lines[1:i], False
    return [], True


def unquote(val: str) -> str:
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
        return val[1:-1]
    return val


def parse_tags(inline_val: str, fm_lines: list[str], key_idx: int) -> tuple[list[str], int]:
    if inline_val:
        flow = inline_val.strip()
        if flow.startswith("[") and flow.endswith("]"):
            flow = flow[1:-1]
        items = [unquote(t.strip()) for t in flow.split(",") if t.strip()]
        return items, 1
    items = []
    consumed = 1
    j = key_idx + 1
    while j < len(fm_lines):
        nxt = fm_lines[j].strip()
        if nxt.startswith("- "):
            items.append(unquote(nxt[2:].strip()))
            consumed += 1
            j += 1
        elif not nxt:
            consumed += 1
            j += 1
        else:
            break
    return items, consumed


def parse_frontmatter(fm_lines: list[str]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    i = 0
    while i < len(fm_lines):
        line = fm_lines[i]
        if not line.strip() or line.startswith((" ", "\t")) or line.lstrip().startswith("#"):
            i += 1
            continue
        if ":" not in line:
            i += 1
            continue
        key, _, raw_val = line.partition(":")
        key = key.strip()
        val = raw_val.strip()
        if key == "tags":
            tags, consumed = parse_tags(val, fm_lines, i)
            fields["tags"] = tags
            i += consumed
            continue
        if key in ("title", "module", "problem_type", "category"):
            if val:
                fields[key] = unquote(val)
        i += 1
    return fields


def read_staged_frontmatter(repo_root: str, file_path: str) -> tuple[dict[str, Any] | None, bool]:
    """Read and parse frontmatter from a staged file. Returns (fields, malformed)."""
    full = os.path.join(repo_root, file_path)
    try:
        with open(full, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None, True
    fm_lines, malformed = split_frontmatter(text)
    if malformed:
        return None, True
    return parse_frontmatter(fm_lines), False


# ---------------------------------------------------------------------------
# Corpus overlap scoring (deterministic subset of five-dimension assessment)
# ---------------------------------------------------------------------------


def load_scan_corpus_module(repo_root: str) -> Any:
    """Import scan-corpus.py as a module via importlib.util."""
    script_dir = Path(__file__).parent
    corpus_script = script_dir / "scan-corpus.py"
    spec = importlib.util.spec_from_file_location("scan_corpus", str(corpus_script))
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod


def build_corpus_index_from_origin_main(repo_root: str, base_ref: str) -> list[dict]:
    """Build a corpus index from origin/main's docs/solutions tree.

    Extracts origin/main:docs/solutions into a temp directory, then runs
    scan-corpus.py's scan() against it.  Falls back to an empty index on
    any error rather than crashing the gate.
    """
    scan_corpus = load_scan_corpus_module(repo_root)
    if scan_corpus is None:
        sys.stderr.write("validate-staged-keepers: could not import scan-corpus.py\n")
        return []

    with tempfile.TemporaryDirectory(prefix="vsk-corpus-") as tmpdir:
        solutions_dir = os.path.join(tmpdir, "docs", "solutions")
        os.makedirs(solutions_dir, exist_ok=True)

        # List all files in origin/main:docs/solutions using git ls-tree.
        ls = run_git(
            ["ls-tree", "-r", "--name-only", "origin/main", "docs/solutions/"],
            cwd=repo_root,
        )
        if ls.returncode != 0 or not ls.stdout.strip():
            # No corpus on origin/main yet — empty index is correct.
            return []

        for rel_path in ls.stdout.splitlines():
            rel_path = rel_path.strip()
            if not rel_path.endswith(".md"):
                continue
            # Extract each file via git show.
            show = run_git(["show", f"origin/main:{rel_path}"], cwd=repo_root)
            if show.returncode != 0:
                continue
            dest = os.path.join(tmpdir, rel_path)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as f:
                f.write(show.stdout)

        index, _warnings = scan_corpus.scan(solutions_dir)
        return index


def overlap_score(staged: dict[str, Any], corpus_entry: dict[str, Any]) -> int:
    """Deterministic three-dimension overlap score.

    Dimensions:
      +1  title exact match (case-insensitive, stripped)
      +1  any tag in common (case-insensitive intersection)
      +1  module match (case-insensitive, stripped)

    Returns 0–3.  A score >= OVERLAP_COLLISION_THRESHOLD is a collision.
    """
    score = 0
    staged_title = (staged.get("title") or "").strip().lower()
    corpus_title = (corpus_entry.get("title") or "").strip().lower()
    if staged_title and corpus_title and staged_title == corpus_title:
        score += 1

    staged_tags = {t.lower() for t in (staged.get("tags") or [])}
    corpus_tags = {t.lower() for t in (corpus_entry.get("tags") or [])}
    if staged_tags & corpus_tags:
        score += 1

    staged_module = (staged.get("module") or "").strip().lower()
    corpus_module = (corpus_entry.get("module") or "").strip().lower()
    if staged_module and corpus_module and staged_module == corpus_module:
        score += 1

    return score


# ---------------------------------------------------------------------------
# Path safety checks
# ---------------------------------------------------------------------------


def is_traversal_safe(p: str) -> bool:
    """Return False if path contains '..' segments or is absolute."""
    if os.path.isabs(p):
        return False
    parts = Path(p).parts
    return ".." not in parts


def is_allowlisted(p: str) -> bool:
    """Return True if path matches docs/solutions/**/*.md."""
    return p.startswith(ALLOWED_PREFIX) and p.endswith(ALLOWED_SUFFIX)


# ---------------------------------------------------------------------------
# Main gate logic
# ---------------------------------------------------------------------------


def run_gates(
    repo_root: str,
    branch: str,
    base_ref: str,
    do_fetch: bool,
) -> None:
    # Activation discriminator — never key on file paths alone.
    if not branch.startswith(BRANCH_PREFIX):
        emit_skipped(f"branch '{branch}' does not start with '{BRANCH_PREFIX}'")

    # Fresh fetch before comparing — a CI runner's remote-tracking ref is stale.
    if do_fetch:
        fetch = run_git(["fetch", "--no-tags", "origin", "main"], cwd=repo_root)
        if fetch.returncode != 0:
            sys.stderr.write(
                f"validate-staged-keepers: git fetch failed: {fetch.stderr}\n"
            )
            sys.exit(2)

    # Compute three-dot name-status diff.
    name_status = get_diff_name_status(repo_root, base_ref)
    if not name_status:
        # No changes staged on this branch — vacuously passes.
        emit_pass()

    failures: list[dict] = []
    warnings: list[dict] = []

    # Separate added vs modified files; collect all touched paths.
    added_paths: list[str] = []
    modified_paths: list[str] = []
    all_touched_paths: list[str] = []

    # --- Gate 1: content allowlist ---
    for status, p in name_status:
        all_touched_paths.append(p)

        # Traversal safety — must check before allowlist.
        if not is_traversal_safe(p):
            failures.append({
                "type": "traversal_path",
                "path": p,
                "detail": "path contains '..' or is absolute",
            })
            continue

        if not is_allowlisted(p):
            failures.append({
                "type": "allowlist_violation",
                "path": p,
                "detail": (
                    f"staged path '{p}' is outside docs/solutions/**/*.md; "
                    "capture PRs may only touch solution docs"
                ),
            })
            continue

        if status == "A":
            added_paths.append(p)
        elif status == "M":
            modified_paths.append(p)
        # D/R/C: allowed path form but we don't need to gate further.

    # --- Size caps ---
    # Per-entry cap.
    for p in added_paths + modified_paths:
        size = get_entry_diff_size(repo_root, base_ref, p)
        if size > PER_ENTRY_CAP_BYTES:
            failures.append({
                "type": "entry_too_large",
                "path": p,
                "cap": PER_ENTRY_CAP_BYTES,
                "measured_bytes": size,
                "detail": (
                    f"entry diff {size} bytes exceeds per-entry cap "
                    f"{PER_ENTRY_CAP_BYTES} bytes"
                ),
            })

    # Per-PR total cap.
    total_size = get_total_diff_size(repo_root, base_ref, added_paths + modified_paths)
    if total_size > PR_CAP_BYTES:
        failures.append({
            "type": "pr_too_large",
            "cap": PR_CAP_BYTES,
            "measured_bytes": total_size,
            "detail": (
                f"total diff {total_size} bytes exceeds PR cap "
                f"{PR_CAP_BYTES} bytes"
            ),
        })

    # --- Frontmatter parse (warning on malformed, continue) ---
    staged_fields: dict[str, dict] = {}
    for p in added_paths + modified_paths:
        fields, malformed = read_staged_frontmatter(repo_root, p)
        if malformed:
            warnings.append({
                "type": "malformed_staged_file",
                "path": p,
                "detail": "frontmatter is malformed or file unreadable; skipping overlap check",
            })
        else:
            staged_fields[p] = fields or {}

    # --- Gate 2: staleness vs current corpus (added files only) ---
    # Build corpus index from origin/main once.
    corpus_index: list[dict] | None = None
    if added_paths:
        corpus_index = build_corpus_index_from_origin_main(repo_root, base_ref)
        for p in added_paths:
            fields = staged_fields.get(p)
            if fields is None:
                continue  # malformed — already warned
            for corpus_entry in corpus_index:
                score = overlap_score(fields, corpus_entry)
                if score >= OVERLAP_COLLISION_THRESHOLD:
                    failures.append({
                        "type": "corpus_collision",
                        "staged_path": p,
                        "corpus_path": corpus_entry.get("path", ""),
                        "overlap_score": score,
                        "detail": (
                            f"staged entry '{p}' overlaps corpus doc "
                            f"'{corpus_entry.get('path', '')}' "
                            f"(overlap score {score}/{OVERLAP_COLLISION_THRESHOLD})"
                        ),
                    })
                    break  # report first collision per staged file

    # --- Gate 3: stale_update_in_place (modified files only, merge path) ---
    if modified_paths:
        merge_base = get_merge_base(repo_root, base_ref)
        for p in modified_paths:
            if origin_main_modified_since(repo_root, merge_base, p):
                failures.append({
                    "type": "stale_update_in_place",
                    "path": p,
                    "detail": (
                        f"'{p}' has also been modified on origin/main since the branch "
                        "base; reconcile before merging to avoid silent last-write-wins"
                    ),
                })

    if failures:
        emit_failed(failures, warnings)
    elif warnings:
        emit_pass_with_warnings(warnings)
    else:
        emit_pass()


# ---------------------------------------------------------------------------
# Argument parsing and entry point
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="validate-staged-keepers",
        description="Hard re-validation gate for staged capture PRs.",
    )
    parser.add_argument(
        "--repo",
        default=None,
        help="Path to the git repository root (default: CWD's git root).",
    )
    parser.add_argument(
        "--branch",
        default=None,
        help=(
            "Branch name to check (default: current branch or $GITHUB_HEAD_REF). "
            "If the branch does not start with 'learning-capture/', the gate is skipped."
        ),
    )
    parser.add_argument(
        "--base",
        default="origin/main",
        help="Base ref for the three-dot diff (default: origin/main).",
    )
    parser.add_argument(
        "--no-fetch",
        action="store_true",
        default=False,
        help="Skip 'git fetch origin main' before comparing (for fixture tests).",
    )
    return parser


def main(argv: list[str]) -> None:
    parser = build_parser()
    args = parser.parse_args(argv[1:])

    start = str(args.repo) if args.repo else os.getcwd()
    repo_root = find_repo_root(start)
    branch = detect_branch(args.branch, repo_root)
    base_ref: str = args.base
    do_fetch = not args.no_fetch

    run_gates(repo_root, branch, base_ref, do_fetch)


if __name__ == "__main__":
    main(sys.argv)
