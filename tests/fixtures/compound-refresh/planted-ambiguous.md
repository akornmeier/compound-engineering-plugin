---
module: fixture-auth
tags: [auth, session]
problem_type: architecture_pattern
---

# Refresh session tokens on the read path

## Problem

Sessions expired mid-request because tokens were only refreshed on writes.

## Solution

Refresh the token in the read-path middleware so any active request extends the
session. The original implementation lived in a `session_refresh` middleware.

## Note on current state

This subsystem was partially refactored: some of the read-path refresh logic was
moved, and part of it may now be handled by a different layer. Whether the
recommendation still holds as written, needs a narrow Update, or should be
Replaced cannot be settled from a file scan alone — it depends on runtime request
ordering that is not statically observable.

<!-- FIXTURE: a PLANTED AMBIGUOUS doc. Update-vs-Replace is genuinely unclear and
the doc itself says verification needs runtime context. The classifier should
return low confidence / ambiguous:true; the module MUST coerce it to `stale` and
MUST NOT emit a destructive verdict (R5). -->
