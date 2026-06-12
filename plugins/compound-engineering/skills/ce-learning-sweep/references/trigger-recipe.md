# Trigger Recipe: Merge-Triggered Learning Sweeps

This document describes how to configure `ce-learning-sweep` to fire automatically
on PR merge — so sweeps happen without being remembered. It covers the primary
path (Claude Code routine), the GitHub Actions alternative, filter guidance,
auth requirements, known constraints, and the always-available manual path.

**Default state of any checkout: no trigger configured.** The manual path works
on every platform with no setup. Trigger machinery is purely additive.

---

## Primary Path: Claude Code Routine

Use a Claude Code routine (configured at claude.ai/code/routines or via `/schedule`)
with a GitHub webhook trigger on the `pull_request.closed` event, filtered to
merged PRs only. This fires once per merge — matching the sweep's one-PR-per-run
contract.

### Webhook trigger configuration

- **Event:** `pull_request.closed`
- **Filter:** `pull_request.merged == true`
- **Target branch:** `main` only (filter on `pull_request.base.ref == "main"`)
- **Skip bot authors:** exclude `pull_request.user.login` matching
  `release-please[bot]`, `dependabot[bot]`, and any other automation accounts
- **Skip capture PRs:** exclude PRs carrying the `learning-capture` label
  (`pull_request.labels[*].name` contains `learning-capture`) — self-sweep
  prevention; defense in depth alongside the skill-level already-swept
  short-circuit

### Routine prompt example

```
Run the ce-learning-sweep skill on PR #{{ pull_request.number }} in headless mode.

This is a triggered run (merge-triggered, no human session). Invoke:
/ce-learning-sweep {{ pull_request.number }} mode:headless

The sweep should stage approved keepers as a capture PR and wait for human
review. Do NOT merge automatically unless learning_sweep_autonomous is set in
the local config.
```

Substitute `{{ pull_request.number }}` with the routine's variable interpolation
syntax for the webhook payload field (verify the exact syntax in the current
routines documentation at code.claude.com/docs/en/routines.md).

---

## Alternative Path: GitHub Actions

If Claude Code routines are unavailable or not preferred, use `claude-code-action`
in a GitHub Actions workflow.

```yaml
name: Learning Sweep on Merge

on:
  pull_request:
    types: [closed]

jobs:
  learning-sweep:
    if: |
      github.event.pull_request.merged == true &&
      github.event.pull_request.base.ref == 'main' &&
      !contains(github.event.pull_request.labels.*.name, 'learning-capture') &&
      github.actor != 'release-please[bot]' &&
      github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1
        with:
          prompt: |
            Run the ce-learning-sweep skill on PR #${{ github.event.pull_request.number }}
            in headless mode. This is a triggered run.
            /ce-learning-sweep ${{ github.event.pull_request.number }} mode:headless
          claude_api_key: ${{ secrets.CLAUDE_API_KEY }}
          github_token: ${{ secrets.LEARNING_SWEEP_TOKEN }}
```

See code.claude.com/docs/en/github-actions.md for current `claude-code-action`
configuration options and required permissions.

---

## Filter Guidance

Apply all three filters together — skipping any one creates gaps:

| Filter | Purpose |
|--------|---------|
| `base.ref == main` | Sweeps target landed work, not feature-branch merges |
| Skip bot authors | `release-please[bot]` and `dependabot[bot]` PRs carry no human learnings |
| Skip `learning-capture` label | Prevents capture PRs from triggering sweeps of themselves |

The `learning-capture` label filter is the primary self-sweep guard at the
trigger layer. The skill-level already-swept short-circuit (`status: skipped —
already swept`) is defense in depth — it catches cases where the label filter
is misconfigured or the label was not applied at trigger time.

**Constants (pinned by tests/learning-sweep-staging.test.ts):**
- Label: `learning-capture`
- Branch prefix: `learning-capture/`

These strings must match exactly in the trigger filter, the skill, and the
validator. Drift in any copy silently breaks self-sweep exclusion, gate
activation, and the already-swept probe.

---

## Auth Requirements

These are requirements, not suggestions. Unattended runs with insufficient
auth create an unauditable or over-privileged trust boundary.

**Token scope:** Use a fine-grained Personal Access Token (PAT) scoped to
**this repo only** with exactly two permissions:
- `contents: write`
- `pull-requests: write`

Never grant `admin`, `workflow`, or any other scope. The token must not be
able to modify branch protection rules, workflows, or other infrastructure.

**Dedicated machine-user account:** Create the PAT on a dedicated machine-user
account (a bot account distinct from any human contributor). Capture PRs then
carry a recognizable, distinct authoring identity. This makes machine authorship
auditable — and the namespace cannot be spoofed into a trust signal (a
human-pushed branch wearing the `learning-capture/` prefix still fails the
identity check and receives normal scrutiny).

**GitHub App alternative:** For organization-level repos, a GitHub App
installation is the more robust option — it provides per-installation scoping,
automatic token rotation, and a clearer audit trail than a PAT.

**Storage:** Store the token in the routine's secret store or as a GitHub
Actions repository secret. Never commit the token to the repo.

**Rotation:** Set an expiry of 90 days and rotate on schedule. A rotation
reminder in your calendar or secrets-management tooling prevents silent
sweep failures when the token expires.

---

## Trust Framing

The `learning-capture` label is a **routing tag**, not a vetting stamp.

A capture PR is identified by three signals together:
1. The `learning-capture/` branch prefix
2. The `learning-capture` label
3. The authoring identity (the dedicated machine-user account)

Never use the namespace or label alone as a trust signal. A human-pushed
branch wearing the `learning-capture/` prefix passes the branch-prefix check
but fails the identity check — it gets normal review scrutiny. The label is
applied by the staging machinery, not by the trigger, and signals routing
intent to human reviewers and to the CI gate.

**Humans still review diffs.** The capture PR waits for human review by
default (`mode:headless`). The autonomous merge path (`mode:autonomous` with
the config pairing) is an explicit opt-in — see the skill's Config section
and the Autonomous path constraints below.

---

## Known Constraints

**Routines are a research preview.** Capabilities, run caps, and the webhook
trigger surface may change. The recipe above reflects current documentation
(code.claude.com/docs/en/routines.md as of 2026-06-12). Verify against current
docs before configuring.

**Plugin content loads at routine creation.** When a routine is saved, it
captures the current plugin version. If you update the `ce-learning-sweep`
skill, re-save the routine so it runs the updated content. Stale plugin content
in a routine is a common silent failure mode after skill updates.

**Daily run caps.** Routines have a daily invocation cap. On a high-activity
repo, cap exhaustion causes missed merges silently — no error is surfaced
to the PR author or repo maintainers.

**Run-cap exhaustion — reconciliation affordance.** After cap exhaustion (or
any period of missed triggers), run this reconciliation probe to find recently
merged PRs that have no corresponding capture PR or swept-clean record:

```bash
# List recently merged PRs on main (not bots, not capture PRs):
gh pr list --state merged --base main --limit 20 \
  --json number,title,author,labels \
  --jq '.[] | select(.author.login | test("\\[bot\\]$") | not) |
        select(.labels | map(.name) | index("learning-capture") | not) |
        {number, title}'

# List capture PRs (any state):
gh pr list --search "label:learning-capture" --state all \
  --json number,title,headRefName \
  --jq '.[] | {number, title, branch: .headRefName}'
```

Compare the two lists. Any merged PR number in the first list that does not
appear as `pr-<number>-` in a capture PR branch name in the second list was
missed and can be swept manually.

---

## Triggered + Autonomous Limitation

The `learning_sweep_autonomous: true` config pairing lives in
`.compound-engineering/config.local.yaml`, which is **gitignored** (local to
the checkout). A fresh routine clone or GitHub Actions runner will **not**
have this file.

Consequence: triggered runs are effectively **headless-only** unless the run
environment explicitly provisions the config file. The skill already handles
this — a triggered `mode:autonomous` run with the key absent downgrades to
headless and states the downgrade in the report.

This is the current design: autonomy stays scoped to deliberate, local
environments. The downgrade behavior is built into the skill and is not a
failure state. If you need triggered+autonomous runs, provision the config
file via the routine's environment or Actions secrets as a file-creation step,
then remove it after the run.

---

## Ruleset Recommendations

These rulesets are not enforced by the skill — apply them at your discretion
on the GitHub repo's branch protection settings for `main`:

**(a) Make `test` a required status check.** Without it, the hard re-validation
gate does not bind GitHub-UI merges of capture PRs. The skill-mediated merge
path re-validates regardless, but a human merging a capture PR directly through
the GitHub UI bypasses that path. Making `test` required closes this gap.

**(b) Require branches up-to-date before merging.** This fully closes the
stale-capture-PR window — a long-stale capture PR cannot be merged through the
GitHub UI without first rebasing onto a current `main`. Without this, a capture
PR open for days may merge over corpus changes that landed after the capture.

---

## Residual Notes

**Copilot code review fires on capture PRs.** The repo ruleset includes
`copilot_code_review: review_on_push`, so Copilot will review machine-staged
capture PRs automatically. This is advisory noise on machine-authored content;
it is acceptable. Do not disable the ruleset to suppress it.

**Worktree environment assumptions.** Staging uses `git worktree` to isolate
writes from the developer's checkout. If `git worktree` is unavailable in the
run environment (some CI containers, some remote runners), the run reports
`staging unavailable` rather than mutating the checkout. Verify the run
environment supports worktrees before deploying the trigger.

---

## Manual Path (Always Available)

On any platform without trigger machinery — or with none configured, which is
the **default state of any checkout** — the manual sweep runs end-to-end with
full capability:

1. Invoke the sweep on any merged PR: `/ce-learning-sweep <PR#>`
2. Review the report and decide in the batched keep/reject menu (interactive
   mode), or pass `mode:headless` / `mode:autonomous` explicitly
3. Approved keepers stage and merge through the same PR machinery as triggered
   runs — identical outcome, human-initiated

No trigger machinery is required for full function. The trigger exists solely
to remove the "someone must remember to run it" friction. Every platform
that can invoke a skill has a fully functional sweep — the manual path is not
a degraded fallback.
