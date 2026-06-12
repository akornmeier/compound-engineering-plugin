#!/usr/bin/env python3
"""Scan docs/drift-events/ and emit a JSON aggregate of drift rates.

Usage:
    python3 scan-drift-events.py [events-dir]
    # events-dir defaults to docs/drift-events

Output (stdout): a single JSON object
    {
      "status": "ok" | "no_drift_data",
      "events_dir": "<resolved absolute path>",
      "events_dir_found": <bool>,
      "events_scanned": <int>,
      "warnings": [ {"file": ..., "reason": ...}, ... ],
      "flagged_count": <int>,       # events with low_confidence or degraded true
      "per_plan": {
        "<plan-basename>": {
          "attempted": <int>,
          "drifted": <int>,
          "rate": <float | null>,   # null when attempted == 0
          "events": <int>,
          "flagged": <int>
        }, ...
      },
      "cross_plan": {
        "attempted": <int>,
        "drifted": <int>,
        "rate": <float | null>,
        "events": <int>,
        "flagged": <int>
      }
    }

Rates are derived as |drifted| / |attempted| at read time — never stored
(ADR 0001). Events with attempted: [] are counted in coverage but excluded
from rate denominators. Low-confidence and degraded events are included and
flagged, never dropped (R12).

Exit codes:
    0 — scan completed (including empty/missing-directory and malformed-file cases)
    non-zero — only for unexpected internal errors

Pure stdlib (no PyYAML or other third-party deps).
"""
import glob
import json
import os
import re
import sys


# ---------------------------------------------------------------------------
# Frontmatter parsing (mirrors scan-corpus.py's tolerant approach)
# ---------------------------------------------------------------------------

def split_frontmatter(text):
    """Return (frontmatter_lines, body_after_fm, malformed).

    A file whose first line is `---` is treated as having frontmatter; the
    block runs until the next `---` line. `malformed` is True when the opening
    delimiter is present but never closed.
    """
    lines = text.split("\n")
    if not lines or lines[0].rstrip() != "---":
        return [], text, False

    for i in range(1, len(lines)):
        if lines[i].rstrip() == "---":
            fm_lines = lines[1:i]
            body = "\n".join(lines[i + 1:])
            return fm_lines, body, False

    return [], text, True


def parse_frontmatter_plan(fm_lines):
    """Extract the `plan` field from frontmatter lines.

    Returns the plan value string or None.
    """
    for line in fm_lines:
        if not line.strip() or line.startswith((" ", "\t")):
            continue
        if ":" not in line:
            continue
        key, _, raw_val = line.partition(":")
        if key.strip() == "plan":
            val = raw_val.strip()
            # Strip surrounding quotes
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            return val
    return None


# ---------------------------------------------------------------------------
# Fenced YAML data block parsing
# ---------------------------------------------------------------------------

def extract_fenced_yaml_block(body):
    """Return the content of the first fenced ```yaml block in body, or None.

    Looks for ``` yaml (with optional space) or ```yaml.
    """
    # Match ``` yaml ... ``` or ```yaml ... ```
    pattern = re.compile(r"```\s*yaml\s*\n(.*?)```", re.DOTALL)
    m = pattern.search(body)
    if m:
        return m.group(1)
    return None


def parse_data_block(block_text):
    """Parse the drift event data block tolerantly.

    Extracts: plan_path, run_id, low_confidence, degraded, drifted, attempted.
    Returns a dict with whatever fields were found.
    """
    fields = {}
    lines = block_text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Skip blank lines and comment lines
        if not stripped or stripped.startswith("#"):
            i += 1
            continue

        if ":" not in line:
            i += 1
            continue

        key, _, raw_val = line.partition(":")
        key = key.strip()
        val = raw_val.strip()

        if key in ("low_confidence", "degraded"):
            fields[key] = val.lower() == "true"
            i += 1
            continue

        if key in ("drifted", "attempted", "remaining", "unverifiable"):
            # Parse flow list: [U1, U2] or [] — or block list
            items, consumed = _parse_list(val, lines, i)
            fields[key] = items
            i += consumed
            continue

        if key in ("plan_path", "run_id"):
            # Strip surrounding quotes
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            fields[key] = val
            i += 1
            continue

        i += 1

    return fields


def _parse_list(inline_val, lines, key_idx):
    """Parse a YAML list value. Returns (items, lines_consumed).

    Handles flow style `[U1, U2]` and block style `- U1` on following lines.
    """
    if inline_val:
        flow = inline_val.strip()
        if flow.startswith("[") and flow.endswith("]"):
            inner = flow[1:-1].strip()
            if not inner:
                return [], 1
            items = [t.strip().strip("'\"") for t in inner.split(",") if t.strip()]
            return items, 1
        # Scalar on same line (unlikely for lists, treat as single-item)
        if flow:
            return [flow.strip("'\"")], 1
        # Empty value — check for block list below
    # Block style
    items = []
    consumed = 1
    j = key_idx + 1
    while j < len(lines):
        nxt = lines[j]
        stripped_nxt = nxt.strip()
        if stripped_nxt.startswith("- "):
            items.append(stripped_nxt[2:].strip().strip("'\""))
            consumed += 1
            j += 1
        elif not stripped_nxt:
            consumed += 1
            j += 1
        else:
            break
    return items, consumed


# ---------------------------------------------------------------------------
# Main scan logic
# ---------------------------------------------------------------------------

def scan(events_dir):
    """Scan events_dir for drift event .md files.

    Returns (events, warnings) where events is a list of dicts:
        {file, plan, attempted_count, drifted_count, low_confidence, degraded}
    and warnings is a list of {file, reason}.
    """
    events = []
    warnings = []

    if not os.path.isdir(events_dir):
        return events, warnings

    # Glob *.md, exclude README.md (case-insensitive on the README check)
    pattern = os.path.join(events_dir, "*.md")
    md_paths = sorted(glob.glob(pattern))
    md_paths = [p for p in md_paths if os.path.basename(p).upper() != "README.MD"]

    for full_path in md_paths:
        fname = os.path.basename(full_path)
        try:
            with open(full_path, encoding="utf-8") as f:
                text = f.read()
        except OSError as exc:
            warnings.append({"file": fname, "reason": f"could not read file: {exc}"})
            continue

        fm_lines, body, malformed = split_frontmatter(text)
        if malformed:
            warnings.append({
                "file": fname,
                "reason": "frontmatter opened with '---' but never closed",
            })
            continue

        # Extract plan from frontmatter
        plan = parse_frontmatter_plan(fm_lines)

        # Extract and parse the fenced YAML data block
        block_text = extract_fenced_yaml_block(body)
        if block_text is None:
            warnings.append({
                "file": fname,
                "reason": "no fenced yaml data block found",
            })
            continue

        data = parse_data_block(block_text)

        # Validate minimum fields
        if "attempted" not in data:
            warnings.append({
                "file": fname,
                "reason": "data block missing required 'attempted' field",
            })
            continue

        # Fallback: derive plan from filename prefix if frontmatter didn't have it
        if not plan:
            # Filename: <plan-basename>--<run_id>.md
            base = fname[:-3] if fname.endswith(".md") else fname
            if "--" in base:
                plan = base.rsplit("--", 1)[0]
            else:
                plan = base

        attempted = data.get("attempted", [])
        drifted = data.get("drifted", [])
        low_confidence = data.get("low_confidence", False)
        degraded = data.get("degraded", False)

        events.append({
            "file": fname,
            "plan": plan,
            "attempted_count": len(attempted),
            "drifted_count": len(drifted),
            "low_confidence": low_confidence,
            "degraded": degraded,
        })

    return events, warnings


def aggregate(events):
    """Build per-plan and cross-plan aggregates from parsed events.

    Events with attempted_count == 0 are included in event counts but
    excluded from rate denominators (no denominator to contribute).
    """
    per_plan = {}
    cross_attempted = 0
    cross_drifted = 0
    cross_events = 0
    cross_flagged = 0

    for ev in events:
        plan = ev["plan"]
        flagged = bool(ev["low_confidence"] or ev["degraded"])

        if plan not in per_plan:
            per_plan[plan] = {
                "attempted": 0,
                "drifted": 0,
                "rate": None,
                "events": 0,
                "flagged": 0,
            }

        entry = per_plan[plan]
        entry["events"] += 1
        if flagged:
            entry["flagged"] += 1

        # Only contribute to denominators when attempted > 0
        if ev["attempted_count"] > 0:
            entry["attempted"] += ev["attempted_count"]
            entry["drifted"] += ev["drifted_count"]

        cross_events += 1
        if flagged:
            cross_flagged += 1
        if ev["attempted_count"] > 0:
            cross_attempted += ev["attempted_count"]
            cross_drifted += ev["drifted_count"]

    # Compute rates
    for entry in per_plan.values():
        if entry["attempted"] > 0:
            entry["rate"] = entry["drifted"] / entry["attempted"]
        else:
            entry["rate"] = None

    cross_rate = (cross_drifted / cross_attempted) if cross_attempted > 0 else None

    return per_plan, {
        "attempted": cross_attempted,
        "drifted": cross_drifted,
        "rate": cross_rate,
        "events": cross_events,
        "flagged": cross_flagged,
    }


def main(argv):
    events_dir = argv[1] if len(argv) > 1 else "docs/drift-events"
    events_abspath = os.path.abspath(events_dir)
    events_found = os.path.isdir(events_dir)

    events, warnings = scan(events_dir)

    if not events:
        result = {
            "status": "no_drift_data",
            "events_dir": events_abspath,
            "events_dir_found": events_found,
            "events_scanned": 0,
            "warnings": warnings,
            "flagged_count": 0,
            "per_plan": {},
            "cross_plan": {
                "attempted": 0,
                "drifted": 0,
                "rate": None,
                "events": 0,
                "flagged": 0,
            },
        }
    else:
        per_plan, cross_plan = aggregate(events)
        flagged_count = sum(
            1 for ev in events if ev["low_confidence"] or ev["degraded"]
        )
        result = {
            "status": "ok",
            "events_dir": events_abspath,
            "events_dir_found": events_found,
            "events_scanned": len(events),
            "warnings": warnings,
            "flagged_count": flagged_count,
            "per_plan": per_plan,
            "cross_plan": cross_plan,
        }

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
