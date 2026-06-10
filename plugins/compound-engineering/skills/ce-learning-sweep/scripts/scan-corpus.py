#!/usr/bin/env python3
"""Scan docs/solutions/ and emit a tolerant JSON index of documented learnings.

Usage:
    python3 scan-corpus.py [corpus-dir]   # corpus-dir defaults to docs/solutions

Output (stdout): a single JSON object
    {
      "index": [ {path, title, module, tags, problem_type, problem_type_key, date}, ... ],
      "warnings": [ {path, reason}, ... ]
    }

Exit codes:
    0 — scan completed (including the empty/missing-directory and
        malformed-entry cases — those are normal outcomes, not failures)
    non-zero — only for unexpected internal errors

This index feeds ce-learning-sweep's corpus verdict step: every candidate
learning is checked against the existing corpus, so an entry dropped here
would be mis-verdicted `new`. The corpus is heterogeneous in practice —
some entries use `category:` instead of `problem_type:`, some use `created:`
instead of `date:`, and at least one file has no frontmatter at all. The
parser is therefore deliberately tolerant: entries with missing fields are
indexed with whatever they have and NEVER dropped. Only frontmatter that is
genuinely malformed (an opening `---` with no closing `---`) is skipped, and
that skip is recorded as a warning so the scan stays observable.

Pure-stdlib (no PyYAML or other third-party deps), mirroring
ce-compound/scripts/validate-frontmatter.py's no-dependency constraint. The
frontmatter parse is intentionally minimal — it extracts only the six fields
the index needs and tolerates both flow-style (`tags: [a, b]`) and block-style
(`tags:` then `- a`) lists, the two shapes the real corpus uses.
"""
import json
import os
import sys

# Fields the index carries. `problem_type` accepts `category` as a fallback
# key; `date` accepts `created` as a fallback key. We record which key
# actually supplied problem_type so the caller can tell a true `problem_type`
# from a `category` mapped in.
PROBLEM_TYPE_KEYS = ("problem_type", "category")
DATE_KEYS = ("date", "created")


def split_frontmatter(text):
    """Return (frontmatter_lines, malformed) for a doc's text.

    A file whose first line is `---` is treated as having frontmatter; the
    block runs until the next `---` line. `malformed` is True when the opening
    delimiter is present but never closed — those entries are skipped with a
    warning rather than guessed at. A file with no leading `---` simply has no
    frontmatter (returns ([], False)) and is indexed from its body instead.
    """
    lines = text.split("\n")
    if not lines or lines[0].rstrip() != "---":
        return [], False

    for i in range(1, len(lines)):
        if lines[i].rstrip() == "---":
            return lines[1:i], False

    # Opening delimiter with no closing delimiter — malformed.
    return [], True


def parse_frontmatter(fm_lines):
    """Extract the indexed fields from frontmatter lines.

    Returns a dict with whatever fields were found. Only top-level mapping
    keys (no leading whitespace) are considered. List values are read in both
    flow style (`tags: [a, b]`) and block style (`tags:` followed by `- a`
    lines). Quoted scalars have their surrounding quotes stripped.
    """
    fields = {}
    i = 0
    while i < len(fm_lines):
        line = fm_lines[i]
        # Only top-level keys; skip nested/array/blank/comment lines.
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

        # Scalar fields we care about. Ignore everything else.
        if key in ("title", "module") or key in PROBLEM_TYPE_KEYS or key in DATE_KEYS:
            if val:
                fields[key] = unquote(val)
        i += 1

    return fields


def parse_tags(inline_val, fm_lines, key_idx):
    """Parse a `tags` value. Returns (tags_list, lines_consumed).

    Handles flow style on the same line (`tags: [a, b]`) and block style on
    following indented `- item` lines. `lines_consumed` is how many input
    lines the value occupied (>= 1, counting the `tags:` line itself).
    """
    if inline_val:
        # Flow style: `[a, b, c]` — strip brackets, split on commas.
        flow = inline_val.strip()
        if flow.startswith("[") and flow.endswith("]"):
            flow = flow[1:-1]
        items = [unquote(t.strip()) for t in flow.split(",") if t.strip()]
        return items, 1

    # Block style: consume following `  - item` lines.
    items = []
    consumed = 1
    j = key_idx + 1
    while j < len(fm_lines):
        nxt = fm_lines[j]
        stripped = nxt.strip()
        if stripped.startswith("- "):
            items.append(unquote(stripped[2:].strip()))
            consumed += 1
            j += 1
            continue
        if not stripped:
            # Blank line inside the block — tolerate and keep scanning.
            consumed += 1
            j += 1
            continue
        break
    return items, consumed


def unquote(val):
    """Strip a single pair of surrounding quotes, if present."""
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
        return val[1:-1]
    return val


def first_heading(text):
    """Return the first markdown ATX heading text, or None."""
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
    return None


def title_from_path(path):
    """Derive a fallback title from the filename (basename without .md)."""
    base = os.path.basename(path)
    if base.endswith(".md"):
        base = base[:-3]
    return base


def build_record(path, fields, text):
    """Assemble an index record from parsed fields, filling fallbacks.

    `path` is the corpus-relative path. Missing fields are simply absent or
    empty; the record is never dropped for missing data. Title falls back to
    the first markdown heading, then to the filename.
    """
    title = fields.get("title") or first_heading(text) or title_from_path(path)

    problem_type = None
    problem_type_key = None
    for key in PROBLEM_TYPE_KEYS:
        if fields.get(key):
            problem_type = fields[key]
            problem_type_key = key
            break

    date = None
    for key in DATE_KEYS:
        if fields.get(key):
            date = fields[key]
            break

    return {
        "path": path,
        "title": title,
        "module": fields.get("module"),
        "tags": fields.get("tags", []),
        "problem_type": problem_type,
        # Records which key supplied problem_type (`problem_type` vs
        # `category`), or None when neither was present.
        "problem_type_key": problem_type_key,
        "date": date,
    }


def scan(corpus_dir):
    """Walk corpus_dir for .md files and return (index, warnings)."""
    index = []
    warnings = []

    if not os.path.isdir(corpus_dir):
        # Missing directory is a normal outcome: an empty index, exit 0.
        return index, warnings

    md_paths = []
    for root, _dirs, files in os.walk(corpus_dir):
        for name in files:
            if name.endswith(".md"):
                md_paths.append(os.path.join(root, name))
    md_paths.sort()

    for full_path in md_paths:
        rel_path = os.path.relpath(full_path, corpus_dir)
        with open(full_path, encoding="utf-8") as f:
            text = f.read()

        fm_lines, malformed = split_frontmatter(text)
        if malformed:
            warnings.append({
                "path": rel_path,
                "reason": "frontmatter opened with '---' but never closed",
            })
            continue

        fields = parse_frontmatter(fm_lines)
        index.append(build_record(rel_path, fields, text))

    return index, warnings


def main(argv):
    corpus_dir = argv[1] if len(argv) > 1 else "docs/solutions"
    index, warnings = scan(corpus_dir)
    json.dump({"index": index, "warnings": warnings}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
