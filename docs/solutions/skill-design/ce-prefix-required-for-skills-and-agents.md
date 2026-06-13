---
title: New skills and agents must use the ce- prefix; enforce it in tests, not just prose
date: 2026-05-01
last_updated: 2026-06-13
category: skill-design
module: compound-engineering
problem_type: convention
component: plugins/compound-engineering
severity: low
applies_when:
  - Adding a new skill directory under plugins/compound-engineering/skills/
  - Adding a new agent file under plugins/compound-engineering/agents/
  - Authoring or reviewing a PR that introduces a new component to the plugin
  - Merging a long-lived branch that forked many commits before the current HEAD
tags:
  - naming-convention
  - ce-prefix
  - skill-authoring
  - test-enforcement
  - plugin-conventions
  - file-extension
  - validator-blindness
  - stale-branch
related:
  - docs/solutions/skill-design/beta-skills-framework.md
related_pr: https://github.com/EveryInc/compound-engineering-plugin/pull/747
---

## Problem

`plugins/compound-engineering/AGENTS.md` already stated that "all skills and agents use the `ce-` prefix to unambiguously identify them as compound-engineering components." But the rule was prose-only, and legacy skills sat unprefixed in the same directory as their `ce-`-prefixed siblings. The combination — a soft rule plus visible exceptions — let a new skill (`riffrec-feedback-analysis`) ship in PR #747 without the prefix. The user caught it post-merge of the first commit, requiring a rename commit on the same PR. (That skill is now `ce-riffrec-feedback-analysis`; the once-unprefixed `every-style-editor` and `file-todos` skills have since been removed, leaving `lfg` as the sole exemption.)

A prose convention that has visible counterexamples and no machine check is, in practice, an *advisory* convention. Any author skim-reading the directory listing sees an unprefixed skill next to `ce-brainstorm` and reasonably concludes the prefix is optional.

## Root cause

Two layered problems:

1. **The rule was unenforced.** Nothing in CI or the test suite would fail when a non-`ce-` skill was added. The frontmatter test asserts that the skill's `name:` matches its directory and that the directory uses `[a-z0-9-]+`, but does not check for the `ce-` prefix.
2. **The exception list was implicit.** Legacy skills predated the rule. Without an explicit allowlist, "predates the rule" looks identical to "the rule doesn't apply" when reading the filesystem.

## Solution

Make the rule mechanically enforced and pin the exceptions explicitly.

### 1. Test enforcement

Enforcement lives in a dedicated test file, `tests/skill-agent-ce-prefix.test.ts`, which walks the skill directories and agent files and asserts the prefix on both the directory/file name and the frontmatter `name`. Exemptions are explicit, named `Set`s that require a written reason per entry:

```ts
const PREFIX = "ce-"

// Exemptions from the ce- prefix rule. Add entries here only with a written
// reason — the exemption list shouldn't become a silent junk drawer.
const SKILL_EXEMPTIONS = new Set<string>([
  // lfg ships as the public command `/lfg` (see plugins/compound-engineering/README.md).
  "lfg",
])
const AGENT_EXEMPTIONS = new Set<string>([])
```

Agents are flat `.md` files under `plugins/compound-engineering/agents/`, filtered by extension and checked the same way as skills:

```ts
const agentFiles = readdirSync(AGENTS_DIR, { withFileTypes: true })
  .filter((entry) =>
    entry.isFile() &&
    entry.name.endsWith(".md") &&
    !AGENT_EXEMPTIONS.has(entry.name),
  )
  .map((entry) => entry.name)
```

Each failure message points at the `AGENTS.md` "Naming Convention" section so the author knows where the rule is documented and how to add a justified exemption. (A parallel copy of the skill/agent checks also lives in `tests/frontmatter.test.ts`; the dedicated file is the canonical home.)

### 2. Strengthened prose

Updated `plugins/compound-engineering/AGENTS.md` to call the prefix mandatory, name the legacy exceptions, point at the test, and forbid extending the allowlist. The prose now says "no exceptions" and tells authors that the test will fail. Prose alone wouldn't have prevented the original mistake, but pairing it with the test gives a single internally consistent story.

### 3. Persistent author memory

Saved a feedback memory in the agent's per-project memory store so future sessions on this repo load the rule automatically and apply it before the test fires. (The exact memory path is machine- and user-specific; the durable point is that the rule lives in author memory as well as in prose and tests.)

## The filename-format dimension: extension regressions slip past counts

The same "unenforced convention regresses" failure has a second face: the agent
filename *extension*. PR #846 migrated every agent off the `.agent.md` double
extension to plain `<name>.md` because `.agent.md` breaks VS Code Copilot tool
access. Like the prefix, that migration left no enforcing check — and the
checks that *look* like they cover agent files do not:

- **The prefix test above is blind to it.** The agent loop filters with
  `entry.name.endsWith(".md")` (see the snippet in section 1). A `.agent.md`
  file ends in `.md` *and* carries the `ce-` prefix, so it passes both the
  filter and the prefix assertion.
- **`release:validate` is blind to it.** It counts agents by matching any
  `*.md` file, so a `.agent.md` file is counted as a healthy agent. A count or
  parity validator answers "how many components?" — it is structurally blind to
  "what format is each one in?"

In PR #24 the `feat/at-team-extracted-agents` branch — forked **199 commits
before** the migration — reintroduced two `.agent.md` agents. `release:validate`
reported `45 agents, in sync` and the prefix test passed; the regression merged
green onto the feature branch and was caught only because a human read the diff
before the final merge.

Two lessons fold back into this convention:

1. **Enforce the filename *format*, not just prefix-and-existence.** Extend the
   agent loop in `tests/skill-agent-ce-prefix.test.ts` to assert each agent
   filename matches exactly `^ce-[a-z0-9-]+\.md$` (no intervening `.agent`
   segment), so a `.agent.md` file fails loudly instead of passing the
   `endsWith(".md")` filter:

   ```ts
   for (const fileName of agentFiles) {
     expect(
       /^ce-[a-z0-9-]+\.md$/.test(fileName),
       `Agent filename "${fileName}" must be exactly ce-<name>.md — no `
         + `.agent segment (see PR #846; .agent.md breaks VS Code Copilot `
         + `tool access).`,
     ).toBe(true)
   }
   ```

2. **Re-audit a long-stale branch against conventions that changed *after* its
   fork point.** A mostly-additive diff can satisfy every count and still
   reintroduce a since-removed convention (an extension, a directory layout, a
   frontmatter shape). Before merging a branch with a far-back fork point,
   confirm it matches the *current* form of conventions migrated between the
   fork point and HEAD — counts and "release:validate in sync" will not tell
   you.

## Prevention

For any plugin convention that is currently prose-only, ask:

- Is there at least one visible counterexample in the codebase that an author could mistake for permission?
- Is there a mechanical check that would fail on violation?

If the answer to the first is yes and the second is no, the convention will eventually be violated. The fix is one of:

- Add a test that asserts the convention with a hard-coded allowlist for legacy exceptions.
- Migrate the legacy exceptions so the rule is universal and no allowlist is needed.

The allowlist pattern is preferred when migration is risky (renaming an installed skill breaks user invocations) but the rule applies cleanly going forward.

## Related

- `plugins/compound-engineering/AGENTS.md` — Naming Convention section now documents the rule and the allowlist.
- `tests/skill-agent-ce-prefix.test.ts` — the dedicated test that implements the enforcement (a parallel copy also lives in `tests/frontmatter.test.ts`).
- PR #747 — the original prefix mistake and the rename + enforcement that came with it.
- PR #846 — the `.agent.md` -> `.md` extension migration (VS Code Copilot tool access).
- PR #24 — a 199-commit-stale branch reintroduced `.agent.md`; caught by human review, motivating the filename-format dimension above.
