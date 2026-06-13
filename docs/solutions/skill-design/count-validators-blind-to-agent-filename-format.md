---
title: Count and parity validators are blind to agent-filename format regressions
date: 2026-06-13
category: skill-design
module: compound-engineering
problem_type: convention
component: tooling
severity: medium
applies_when:
  - Adding or renaming an agent file under plugins/compound-engineering/agents/
  - Merging a long-lived branch that forked many commits before the current HEAD
  - Relying on release:validate or any count/parity check to catch a convention regression
tags:
  - agent-filename
  - file-extension
  - convention-enforcement
  - validator-blindness
  - stale-branch
  - vscode-copilot
  - release-validate
  - test-enforcement
---

# Count and parity validators are blind to agent-filename format regressions

## Context

PR #846 migrated every agent off the `.agent.md` double extension to plain
`<name>.md` because `.agent.md` breaks VS Code Copilot tool access. That
migration left no machine check behind to keep the convention from being
undone. In PR #24, the `feat/at-team-extracted-agents` branch — which had
forked **199 commits before** the migration — reintroduced two `.agent.md`
agents. The regression merged green onto the feature branch and was caught
only because a human read the diff before the final merge.

Two existing checks both reported "all good" while the wrong extension was
present:

- `bun run release:validate` counts agents by matching any `*.md` file, so it
  reported `45 agents, in sync` with two `.agent.md` files in the tree.
- `tests/skill-agent-ce-prefix.test.ts` filters agents with
  `entry.name.endsWith(".md")` (line ~63). A `.agent.md` file ends in `.md`
  **and** carries the `ce-` prefix, so it passes both the filter and the
  prefix assertion.

## Guidance

Two independent guardrails, one specific and one general:

1. **Enforce the filename *format*, not just its existence and prefix.** Add a
   source-side assertion that every agent file matches exactly
   `ce-<name>.md` with no intervening `.agent` segment. The natural home is
   `tests/skill-agent-ce-prefix.test.ts`, which already owns the agent-naming
   convention family (see the related ce-prefix doc) — extend its agent loop
   rather than adding a parallel test. A check that rejects any agent filename
   containing `.agent.md` (or, stricter, anything not matching
   `^ce-[a-z0-9-]+\.md$`) would have failed loudly on PR #24.

2. **Re-audit a long-stale branch against conventions that changed *after* its
   fork point.** A count or parity validator answers "how many components do
   we have?" — it is structurally blind to "what format is each one in?" When
   merging a branch that forked far back, the diff can satisfy every count and
   still reintroduce a since-removed convention (an extension, a directory
   layout, a frontmatter shape). Before merging, scan for conventions that were
   migrated between the fork point and HEAD and confirm the branch matches the
   *current* form, not the form that was canonical when it forked.

## Why This Matters

The failure is silent and recurring. `release:validate` passing is routinely
read as "the plugin inventory is healthy," and a green test suite is read as
"naming conventions hold." Neither signal covers file *format*, so a
`.agent.md` file ships looking fully validated while it breaks VS Code Copilot
tool access for the affected agents. Every future long-stale-branch merge — and
every hand-added agent that guesses the old extension — re-runs the same trap.
A single format assertion converts a human-review catch into a CI failure that
cannot be skipped.

The general lesson generalizes past this one extension: a settled migration
that leaves no enforcing check is an *advisory* convention, and advisory
conventions regress whenever a contributor (or a stale branch) hasn't
internalized them. This is the same root shape as the `ce-` prefix learning —
prose-only rules with no machine check eventually get violated — applied to the
filename-format dimension that the count/prefix checks don't see.

## When to Apply

- Authoring, renaming, or reviewing any agent file under
  `plugins/compound-engineering/agents/`.
- Merging any branch whose fork point is far behind `main`, especially when the
  diff is mostly additive and "release:validate is in sync" is the only
  format-level signal.
- Designing a count/parity/inventory validator — decide explicitly whether it
  also needs to assert *shape*, because by default it will only assert *count*.

## Examples

Before — a `.agent.md` file passes both guardrails:

```ts
// tests/skill-agent-ce-prefix.test.ts (existing filter)
const agentFiles = readdirSync(AGENTS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && /* ... */)
// "ce-accessibility-reviewer.agent.md" -> endsWith(".md") === true -> PASSES
```

```
$ bun run release:validate
Release metadata is in sync. compound-engineering currently has 45 agents, ...
# green, with two .agent.md files present
```

After — assert exact format so the regression fails loudly:

```ts
for (const fileName of agentFiles) {
  expect(
    /^ce-[a-z0-9-]+\.md$/.test(fileName),
    `Agent filename "${fileName}" must be exactly ce-<name>.md with no `
      + `intervening .agent segment (see PR #846; .agent.md breaks VS Code `
      + `Copilot tool access).`,
  ).toBe(true)
}
// "ce-accessibility-reviewer.agent.md" -> FAILS
```

## Related

- `docs/solutions/skill-design/ce-prefix-required-for-skills-and-agents.md` —
  same convention family and same test file; that doc covers the `ce-` prefix
  dimension, this one covers the extension/format dimension and the
  count-validator blind spot. Candidates for consolidation into a single
  "agent filename must match `^ce-[a-z0-9-]+\.md$`, enforced in tests" entry.
- PR #846 — the original `.agent.md` -> `.md` migration (VS Code Copilot tool
  access).
- PR #24 — the stale-branch reintroduction and the human-caught fix.
