---
module: fixture-cache
tags: [cache, invalidation]
problem_type: best_practice
---

# Never invalidate the cache synchronously on write

## Problem

Write latency spiked because each write blocked on a synchronous cache
invalidation round-trip inside the transaction.

## Solution

Never invalidate the cache synchronously on the write path. Enqueue an
**asynchronous** invalidation job after the transaction commits, and rely on a
short TTL to bound staleness in the meantime.

## Prevention

Keep the write path free of cache I/O — synchronous invalidation couples write
latency to cache availability.

<!-- FIXTURE: PLANTED CONTRADICTION (pair B). Same module `fixture-cache` as
contradiction-a.md, recommends the OPPOSITE invalidation strategy (async vs sync).
A direct cross-doc contradiction the loop-until-dry pass should detect. -->
