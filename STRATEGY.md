---
name: Compound Engineering
last_updated: 2026-06-04
---

# Compound Engineering Strategy

## Target problem

Engineering work with raw agentic tools doesn't compound — each task restarts from zero, hard-won planning and lessons aren't captured or reused, and new Claude Code capabilities go underexploited because there's no system that turns yesterday's work into today's leverage.

## Our approach

The compounding loop is the bet: every skill writes durable artifacts (`STRATEGY.md`, plans, learnings via `ce-compound`) that the next skill reads as grounding, so leverage accrues in the repo instead of evaporating per-session. The plugin stays on Claude Code's bleeding edge so that loop always runs on the strongest available primitives.

## Who it's for

**Primary:** The single developer fluent in agentic tooling who treats Claude Code as their primary engineering surface. They're hiring Compound Engineering to turn a pile of one-off agent invocations into a system — capturing plans, reviews, and learnings so each task compounds — and to ride new Claude Code capabilities without rebuilding their workflow each time.

## Key metrics

- **Loop adoption** — share of real tasks that run the chain (plan → review → compound) vs. one-off skill calls; measured from session history.
- **Learnings reuse** — how often a prior `ce-compound` learning is surfaced and applied in a later task; measured from repo artifacts and session history.
- **Rework / churn rate** — how often plan, review, or work output needs redoing; qualitative today, not yet instrumented.

<!-- The dynamic workflows surface (see Tracks) may add metrics once supported; record them here when they exist rather than inventing them now. -->

## Tracks

### Bleeding-edge Claude Code leverage

Adopt new Claude Code primitives fast — dynamic workflows is the live example.

_Why it serves the approach:_ Keeps the compounding loop running on the strongest available primitives.

### The compounding loop

Deepen the artifact chain (strategy → plan → review → compound → pulse) so leverage accrues across tasks.

_Why it serves the approach:_ This is the core bet — it's the mechanism by which work compounds.

### Cross-platform reach

Keep the converter shipping the plugin to Codex, Cursor, Copilot, and other targets.

_Why it serves the approach:_ Lets the loop run wherever the developer works, not just in Claude Code.
