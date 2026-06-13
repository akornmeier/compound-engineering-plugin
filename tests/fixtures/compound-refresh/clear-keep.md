---
module: fixture-logging
tags: [logging, conventions]
problem_type: convention
---

# Prefer structured logging over string interpolation

## Problem

Free-text log lines (`log("user " + id + " did " + action)`) are hard to query,
aggregate, and alert on once log volume grows.

## Solution

Emit logs as structured key/value records (`log.info("user_action", { user_id, action })`)
so downstream tooling can filter and aggregate on fields rather than regexing prose.

## Prevention

When adding a log line, ask whether an operator would want to filter on any value
in it. If yes, make that value a field, not part of the message string.

<!-- FIXTURE: a timeless convention with no version-specific code references. The
classifier should reach Keep at high confidence; nothing here can have drifted. -->
