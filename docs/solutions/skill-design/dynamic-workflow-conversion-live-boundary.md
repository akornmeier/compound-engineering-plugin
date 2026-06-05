---
module: compound-engineering dynamic-workflow conversions
date: 2026-06-04
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "Converting a fan-out-heavy skill step (persona dispatch, merge, validation) to a Claude Code dynamic workflow"
  - "Authoring any Workflow-tool script that dispatches ce-* subagents or consumes args"
tags:
  - dynamic-workflows
  - claude-code
  - subagents
  - skill-design
  - verification
  - code-review
---

# Converting a skill step to a dynamic workflow: the live-boundary contracts

## Context

The dynamic-workflows opportunity map plans to move several fan-out-heavy skill steps onto Claude Code dynamic workflows. The first conversion was `ce-code-review`'s `mode:agent` report-only fan-out (parallel persona reviewers -> deterministic merge -> Stage 5b validation -> JSON envelope).

Every static test passed: the merge module had 26 unit tests, the build-time assembly was checked for syntax validity and `meta`-first ordering, and the Codex/OpenCode content transforms were asserted to preserve the skill. The PR looked done. Then the **first live `Workflow` run returned a completely empty review** — `0/2 reviewers`, `run_id: "unknown-run"`, no findings — while all tests stayed green. Three runs were needed to surface and fix three distinct runtime-contract violations, none of which is reachable below the live boundary.

## Guidance

When converting a skill step to a dynamic workflow, design for these runtime contracts up front, and treat a live smoke run as a mandatory acceptance gate.

**1. `args` is delivered as a JSON string, not an object.** A naive `const A = args || {}` keeps the raw string, so every `A.field` access is `undefined` and the workflow silently runs with all defaults. Parse defensively, matching the platform's own example workflows:

```js
let A = args;
if (typeof A === "string") {
  try { A = JSON.parse(A); } catch (e) { A = {}; }
}
A = A || {};
```

**2. `agent({ agentType })` resolves plugin-namespaced ids, not bare names.** Inside a workflow, `agentType: "ce-security-reviewer"` throws `agent type 'ce-security-reviewer' not found`. The registry key is the **plugin-namespaced** `compound-engineering:ce-security-reviewer`. This is the opposite of the skill-prose convention (AGENTS.md says reference agents by the bare `ce-<name>` form from SKILL.md) — the two resolution paths are different, and the bare form that is correct in prose is wrong in a workflow `agent()` call.

**3. Do not silently swallow dispatch failures.** A defensive `.catch(() => null)` around `agent()` turns an `agentType`-resolution error into a harmless-looking "dropped agent," so the bug surfaces only as empty output with no signal. Log the failure:

```js
agent(prompt, { agentType, schema })
  .then((r) => r)
  .catch((e) => {
    log("persona " + name + " (" + agentType + ") failed: " + (e && e.message ? e.message : String(e)));
    return null;
  });
```

**4. A live smoke run is a required acceptance gate for every conversion.** Assembly, merge, and transform unit tests verify everything *except* that the workflow actually runs and dispatches agents. Run the real `Workflow` against a small fixture (a planted, known issue) and assert the envelope shape and that agents actually executed (non-zero `subagent_tokens`, populated `reviewers`) before trusting the path.

## Why This Matters

The shared failure mode of all three bugs is **silent empty/degraded output that passes every static test**. CI stays green; the converted skill ships; and every real invocation produces a confident-looking empty result. For a machine-handoff path like `ce-code-review mode:agent` (called by `ce-work` and CI), that means automated reviews silently stop finding anything. Below-the-live-boundary tests give false confidence precisely because the contracts that break are the ones only the live runtime enforces.

## When to Apply

- Every skill-step conversion in the dynamic-workflows opportunity map — the contracts above are not specific to `ce-code-review`; any workflow that takes `args` or dispatches `ce-*` agents hits all three.
- Reviewing a PR that adds or edits a Workflow-tool script: check the arg parse, the `agentType` namespacing, and that dispatch errors are logged, and require evidence of a live run.

## Examples

Live-eval result that exposed the bugs, and the result after fixing them (same planted SQL-injection fixture):

```
# Before (bug #1, args unparsed):   0/0 reviewers, run_id "unknown-run"
# After bug #2 (bare agentType):    0/2 reviewers, dropped_agents 2, 0 tokens
#   log (once unmasked): "agent type 'ce-security-reviewer' not found.
#    Available: ... compound-engineering:ce-security-reviewer ..."
# After all three fixed:            status complete, verdict "Not ready",
#   reviewers [security, correctness], 2x P0 + 1 finding,
#   Stage 5b validated_true 3, deterministic merge numbered/sorted
```

See `plugins/compound-engineering/skills/ce-code-review/workflows/` (the `code-review-fanout.js` template + `merge-findings.js` module + generated artifact) and `docs/plans/2026-06-04-001-feat-ce-code-review-workflow-fanout-plan.md`. Dynamic workflows are Claude-Code-only, so this whole class of contract lives behind the `mode:agent` cross-platform guard.
