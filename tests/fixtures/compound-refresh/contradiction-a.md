---
module: fixture-cache
tags: [cache, invalidation]
problem_type: best_practice
---

# Invalidate the cache synchronously on write

## Problem

Stale reads appeared immediately after a write because the cache still held the
old value.

## Solution

Always invalidate (delete) the cache entry **synchronously, inside the same
write transaction**, before returning to the caller. A reader after the write
then misses and repopulates from the source of truth.

## Prevention

Never defer cache invalidation to a background job — a reader between the write
and the deferred job sees a stale value.

<!-- FIXTURE: PLANTED CONTRADICTION (pair A). Shares module `fixture-cache` with
contradiction-b.md, so buildClusters groups them; the two recommend OPPOSITE
invalidation strategies. The contradiction pass must surface this within the cap. -->
